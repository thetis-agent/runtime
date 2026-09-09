/** Keep session control separate from the provider stream inside the environment; KS-004, ADR 0019. */
import { connect } from '../../lib/ndjson/socket.ts';
import { Peer } from '../../lib/socket/index.ts';
import type { Handler } from '../../lib/socket/index.ts';
import type { Method, Note } from '../../contracts/kernel-socket/types.ts';
import type { Input } from '../../contracts/turn-events/types.ts';
import { ProviderClient } from '../../lib/provider/client.ts';
import { clock } from '../../lib/events/index.ts';
import type { Stage } from '../../lib/events/stages.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Runtime } from '../../lib/package-loader/types.ts';
import { Sessions } from './sessions.ts';
import { capabilities } from './protocol.ts';

class SessionControl {
  readonly #sessions: Sessions;
  readonly #schemas: Schemas;
  readonly #person: string;
  #drained: Promise<Result<void>> | undefined;
  constructor(sessions: Sessions, schemas: Schemas, person: string) { this.#sessions = sessions; this.#schemas = schemas; this.#person = person; }

  handlers(): ReadonlyMap<Method, Handler> {
    return new Map<Method, Handler>([
      ['health.probe', async () => {
        const drained = await this.#drained; if (drained && !drained.ok) return drained;
        return { ok: true, value: { ready: true, active: this.#sessions.active, draining: this.#drained !== undefined } };
      }],
      ['session.list', params => params['person'] !== undefined && params['person'] !== this.#person ? Promise.resolve(failure('forbidden', 'The conversation list belongs to this environment.')) : this.#sessions.list()],
      ['session.create', params => {
        const { surface, project } = params;
        if (typeof surface !== 'string' || project !== undefined && typeof project !== 'string') return Promise.resolve(failure('invalid-args', 'The conversation metadata is invalid.'));
        return this.#sessions.create({ surface, ...(project === undefined ? {} : { project }) });
      }],
      ['session.submit', params => {
        const input = params['input']; const conversation = params['conversation'];
        if (typeof conversation !== 'string' || !this.#schemas.validator<Input>('turn-events', 'input')(input)) return Promise.resolve(failure('invalid-args', 'The input violates the turn-event schema.'));
        return this.#sessions.submit(conversation, input);
      }],
      ['session.cancel', params => Promise.resolve(typeof params['conversation'] === 'string' ? this.#sessions.cancel(params['conversation']) : failure('invalid-args', 'The conversation id is invalid.'))]
    ]);
  }

  async note(note: Note): Promise<Result<void>> {
    if (note.note === 'run.stop') this.#drained ??= this.#sessions.pause().then(() => ({ ok: true, value: undefined }), () => failure('io', 'The environment could not drain its conversations.'));
    if (note.note === 'env.updated' && note.params['resume'] === true) {
      const drained = await this.#drained; if (drained && !drained.ok) return drained;
      this.#sessions.resume(); this.#drained = undefined;
    }
    return { ok: true, value: undefined };
  }
}

export async function control(config: Runtime, stages: readonly Stage[], schemas: Schemas): Promise<Result<Peer>> {
  if (!config.controlPath) return failure('io', 'The environment monitor endpoint is absent.');
  const sessions = await Sessions.open(config.root, { stages, schemas, clock, provider: new ProviderClient(config.providerSocket, schemas, config.token), options: config,
    report: params => peer.notify({ note: 'turn.report', params }) });
  if (!sessions.ok) return sessions;
  const opened = await connect(config.controlPath); if (!opened.ok) return opened;
  const handler = new SessionControl(sessions.value, schemas, config.person);
  const peer = new Peer(opened.value, schemas, clock, capabilities, { handlers: handler.handlers(), note: note => handler.note(note) });
  const connected = await peer.connect();
  return connected.ok ? { ok: true, value: peer } : connected;
}
