/** Forward inherited caller evidence only to declared, mounted services; ADR 0019, TS-001–004. */
import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { CallRequest, CallAnswer } from '@/contracts/turn-events/types.ts';
import type { Entry, Setup } from '@/lib/package-loader/types.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Schemas } from '@/lib/schema/index.ts';
import { send, socketFrames } from '@/lib/ndjson/socket.ts';
import { clock } from '@/lib/events/index.ts';
import type { Clock } from '@/lib/events/index.ts';

export type ServiceCall = (service: string, request: CallRequest, signal?: AbortSignal) => Promise<CallAnswer>;
export const toolClientLimits = { active: 8, deadlineMs: 120000 };
export function toolError(id: string, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
  return { id, ok: false, error: { code, message } };
}

export async function toolSchemas(schemas: Schemas): Promise<Record<string, unknown>> {
  await schemas.load();
  const raw: unknown = JSON.parse(await readFile(new URL('../../contracts/tool-service/schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed tool service schema is invalid.');
  return raw;
}

export class ToolClient {
  readonly #active = new Set<AbortController>();
  readonly #schemas: Schemas;
  readonly #token: string;
  readonly #time: Clock;
  #closed = false;
  constructor(token: string, schemas: Schemas, time: Clock = clock) { this.#token = token; this.#schemas = schemas; this.#time = time; }

  async call(path: string, request: CallRequest, signal?: AbortSignal): Promise<CallAnswer> {
    if (this.#closed || this.#active.size >= toolClientLimits.active) return toolError(request.id, 'budget', 'The tool service client is unavailable or full.');
    if (!this.#token || !path.startsWith('/') || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 1) return toolError(request.id, 'invalid-args', 'The tool service connection is invalid.');
    const controller = new AbortController(); const timer = new AbortController(); const socket = new Socket();
    this.#active.add(controller);
    const cancel = (): void => { controller.abort(); socket.destroy(); };
    signal?.addEventListener('abort', cancel, { once: true }); controller.signal.addEventListener('abort', () => { socket.destroy(); }, { once: true });
    const waiting = this.#time.wait(Math.min(request.deadlineMs, toolClientLimits.deadlineMs), timer.signal).then(() => { if (!timer.signal.aborted) cancel(); });
    try {
      if (signal?.aborted) cancel();
      if (aborted(controller.signal)) return toolError(request.id, 'deadline', 'The tool service request was cancelled.');
      const connected = await new Promise<boolean>(resolve => {
        socket.on('error', () => { resolve(false); }); socket.once('close', () => { resolve(false); });
        socket.once('connect', () => { resolve(true); }); socket.connect(path);
      });
      if (!connected) return toolError(request.id, aborted(controller.signal) ? 'deadline' : 'io', 'The tool service connection failed.');
      const schema = await toolSchemas(this.#schemas);
      const validate = this.#schemas.definition<CallAnswer>(schema, 'response');
      const sent = await send(socket, { v: '1', runToken: this.#token, call: request });
      if (!sent.ok) return toolError(request.id, 'io', 'The tool service request could not be sent.');
      const reply = await socketFrames(socket).next();
      if (aborted(controller.signal)) return toolError(request.id, 'deadline', 'The tool service request exceeded its deadline or was cancelled.');
      if (reply.done || !reply.value.ok || !validate(reply.value.value) || reply.value.value.id !== request.id) return toolError(request.id, 'io', 'The tool service reply is invalid.');
      return reply.value.value;
    } catch { return toolError(request.id, aborted(controller.signal) ? 'deadline' : 'io', 'The tool service exchange failed.'); }
    finally { timer.abort(); cancel(); signal?.removeEventListener('abort', cancel); await waiting; this.#active.delete(controller); }
  }

  close(): void { this.#closed = true; for (const controller of this.#active) controller.abort(); }
}

export function stageService(entry: Entry, setup: Setup, schemas: Schemas): { call: ServiceCall; close(): void } {
  const client = new ToolClient(setup.runtime?.token ?? '', schemas);
  const declared = new Set(Object.keys({ ...entry.manifest.requires, ...entry.manifest.provides }));
  return { close: () => { client.close(); }, call: (name, request, signal) => {
    const provision: unknown = setup.provided[name];
    if (!name.startsWith('service/') || !declared.has(name) || !isObject(provision) || typeof provision['endpoint'] !== 'string') {
      return Promise.resolve(toolError(request.id, 'gone', 'The package has no declared connection to this service.'));
    }
    return client.call(provision['endpoint'], request, signal);
  } };
}

function aborted(signal: AbortSignal): boolean { return signal.aborted; }
