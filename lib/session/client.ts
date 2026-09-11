/** Read schema-bound batches only from the scoped environment socket; KS-004, ADR 0019. */
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { Peer } from '@/lib/socket/index.ts';
import { connect } from '@/lib/ndjson/socket.ts';
import type { Schemas, Result, Validator } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Batch, Subscribed } from './types.ts';
import type { CallAnswer } from '@/contracts/turn-events/types.ts';

export const settings = { endpoint: '/services/environment/current.sock', turnMs: 600000, requestMs: 30000 };

export class SessionClient {
  readonly peer: Peer;
  readonly #batch: Validator<Batch>;
  readonly #subscribed: Validator<Subscribed>;
  readonly #answer: Validator<CallAnswer>;
  readonly #receive: (batch: Batch) => Promise<Result<void>>;
  readonly #clock: Clock;
  readonly #ended = Promise.withResolvers<Result<void>>();
  #conversation: string | undefined;
  #cursor: number | undefined;
  private constructor(socket: Socket, schemas: Schemas, clock: Clock, schema: Record<string, unknown>, receive: (batch: Batch) => Promise<Result<void>>) {
    this.#clock = clock; this.#receive = receive;
    this.#batch = schemas.compile<Batch>(schema);
    this.#subscribed = schemas.compile<Subscribed>({ ...schema, $id: 'thetis://internal/session-subscribed/1', $ref: '#/$defs/subscribed' });
    this.#answer = schemas.validator<CallAnswer>('turn-events', 'callAnswer');
    this.peer = new Peer(socket, schemas, clock, ['session.subscribe', 'session.list', 'session.create', 'session.submit', 'session.cancel', 'session.request', 'health.probe', 'notice'], { handlers: new Map(), note: note => this.#note(note.params) });
  }

  static async open(path: string, schemas: Schemas, clock: Clock, receive: (batch: Batch) => Promise<Result<void>>): Promise<Result<SessionClient>> {
    const raw: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(raw)) throw new Error('The committed session stream schema is invalid.');
    const socket = await connect(path); if (!socket.ok) return failure('io', 'The scoped environment session socket is unavailable.');
    const client = new SessionClient(socket.value, schemas, clock, raw, receive);
    const accepted = await client.peer.connect();
    if (!accepted.ok || accepted.value.scope !== 'person') { client.close(); return accepted.ok ? failure('forbidden', 'The session stream must belong to a person.') : accepted; }
    void client.peer.finished().then(result => { client.#ended.resolve(result.ok ? failure('io', 'The session stream closed before end.') : result); });
    return { ok: true, value: client };
  }

  async subscribe(conversation: string, from?: number): Promise<Result<Subscribed>> {
    if (this.#conversation) return failure('budget', 'The session connection already has a subscription.');
    this.#conversation = conversation; this.#cursor = from;
    const result = await this.peer.call('session.subscribe', { conversation, ...(from === undefined ? {} : { from }) });
    if (!result.ok) return result;
    if (!this.#subscribed(result.value) || result.value.conversation !== conversation) return failure('protocol', 'The environment returned an invalid subscription.');
    this.#cursor ??= result.value.cursor;
    return { ok: true, value: result.value };
  }

  /** Ask the package that contributed a panel to do one thing it declared; ADR 0051.
   *
   * Sent on this connection, which is already subscribed to exactly one conversation, so the
   * environment can refuse a request naming any other without consulting a list: the route is the
   * binding. The answer is the same `callAnswer` a tool returns, because what answers it is the
   * contributing package's own call hook — nothing new had to be invented for a package to reply. */
  async request(conversation: string, name: string, verb: string, args: Record<string, unknown>, timeoutMs = settings.requestMs): Promise<Result<CallAnswer>> {
    if (conversation !== this.#conversation) return failure('forbidden', 'The request names a conversation this stream is not reading.');
    const result = await this.peer.call('session.request', { conversation, package: name, verb, args }, timeoutMs);
    if (!result.ok) return result;
    return this.#answer(result.value) ? { ok: true, value: result.value } : failure('protocol', 'The environment returned an invalid answer.');
  }

  async #note(params: Record<string, unknown>): Promise<Result<void>> {
    if (!this.#batch(params)) return failure('protocol', 'The session batch violates its schema.');
    if (params.conversation !== this.#conversation || params.events.some(event => event.conversation !== this.#conversation)) return failure('forbidden', 'The session batch belongs to another conversation.');
    if (this.#cursor !== undefined && params.cursor !== this.#cursor + params.events.length) return failure('protocol', 'The session batch cursor is not contiguous.');
    this.#cursor = params.cursor;
    const received = await this.#receive(params); if (!received.ok) { this.#ended.resolve(received); return received; }
    if (params.events.some(event => event.type === 'end')) this.#ended.resolve({ ok: true, value: undefined });
    return { ok: true, value: undefined };
  }

  async end(): Promise<Result<void>> {
    const cancel = new AbortController();
    try { return await Promise.race([this.#ended.promise, this.#clock.wait(settings.turnMs, cancel.signal).then(() => failure('deadline', 'The session stream exceeded its turn deadline.'))]); }
    finally { cancel.abort(); }
  }
  close(): void { this.peer.close(); }
}
