/** Probe actual client-major negotiation on private trusted-kernel sockets; GN-007, ADR 0012 §6. */
import type { Socket } from 'node:net';
import { Service, serviceLimits } from '../service/lifecycle.ts';
import type { Clock } from '../events/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import { failure } from '../schema/index.ts';
import { socketFrames, send } from '../ndjson/socket.ts';
import type { Request } from '../../contracts/kernel-socket/types.ts';
import schema from './schema.json' with { type: 'json' };
import type { Hello } from './types.ts';

export class KernelTransport {
  readonly #service: Service;
  readonly #schemas: Schemas;
  readonly #majors: readonly string[];
  readonly #clients = new Map<Socket, string>();
  constructor(schemas: Schemas, clock: Clock, majors: readonly string[]) {
    this.#schemas = schemas; this.#service = new Service(clock, serviceLimits, 'io'); this.#majors = [...majors];
  }
  get clients(): string[] { return [...new Set(this.#clients.values())].sort(); }
  open(path: string): Promise<Result<void>> {
    return this.#service.open(path, async connection => {
      try { return await this.#serve(connection.socket, connection.admitted); }
      finally { this.#clients.delete(connection.socket); connection.socket.destroy(); }
    }, result => { if (!result.ok) process.stderr.write(`${JSON.stringify(result)}\n`); });
  }
  async close(): Promise<Result<void>> {
    for (const socket of this.#clients.keys()) socket.destroy();
    return this.#service.stop();
  }
  async #serve(socket: Socket, admitted: () => void): Promise<Result<void>> {
    const input = socketFrames(socket); const first = await input.next();
    const hello = this.#schemas.compile<Hello>({ ...schema, $id: 'thetis://internal/maintenance/hello', $ref: '#/$defs/hello' });
    if (first.done || !first.value.ok || !hello(first.value.value)) return failure('invalid-args', 'The kernel client handshake is invalid.');
    const major = first.value.value.v;
    if (!this.#majors.includes(major)) return send(socket, { id: 'connect', error: { code: 'unsupported', message: `The candidate kernel does not support client major ${major}.` } });
    const connected = await send(socket, { v: major, person: '', scope: 'deployment', capabilities: ['health.probe'] }); if (!connected.ok) return connected;
    this.#clients.set(socket, major); admitted();
    for await (const row of input) {
      if (!row.ok) return row;
      if (!this.#schemas.validator<Request>('kernel-socket', 'request')(row.value)) return failure('invalid-args', 'The kernel client request is invalid.');
      const result = row.value.method === 'health.probe' ? { result: { ready: true, major } } : { error: { code: 'unsupported', message: 'This maintenance socket exposes only kernel health.' } };
      const sent = await send(socket, { id: row.value.id, ...result }); if (!sent.ok) return sent;
    }
    return { ok: true, value: undefined };
  }
}
