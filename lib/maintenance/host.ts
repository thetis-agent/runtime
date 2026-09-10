/** Keep kernel maintenance controls on inherited IPC while probing without deployment writers; GN-007. */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { KernelTransport } from './transport.ts';
import schema from './schema.json' with { type: 'json' };
import type { Command } from './types.ts';
import type { Principal as ConfiguredPrincipal } from '@/lib/deployment/types.ts';
type Principal = Pick<ConfiguredPrincipal, 'id' | 'role' | 'observeOthers'> & { projects: readonly string[] };
export interface KernelApplication {
  identity: { principal(id: string): Principal | undefined };
  runtime: { maintenancePause(person: Principal): Promise<Result<void>>; maintenanceResume(person: Principal): Promise<Result<void>> };
  close(): Promise<Result<void>>;
}
type Start = (path: string) => Promise<Result<KernelApplication>>;
class Application {
  #current: KernelApplication | undefined;
  readonly #start: Start; readonly #path: string; readonly #administrator: string;
  constructor(current: KernelApplication, start: Start, path: string, administrator: string) { this.#current = current; this.#start = start; this.#path = path; this.#administrator = administrator; }
  async close(): Promise<Result<void>> { const current = this.#current; this.#current = undefined; return current ? current.close() : { ok: true, value: undefined }; }
  async execute(command: Command, server: KernelTransport): Promise<Result<unknown>> {
    if (command.method === 'stop') return this.close();
    if (!this.#current) return failure('io', 'The kernel application is stopped.');
    const person = this.#current.identity.principal(this.#administrator);
    if (!person || person.role !== 'admin') return failure('forbidden', 'Kernel maintenance requires its configured administrator.');
    switch (command.method) {
      case 'status': return { ok: true, value: { clients: server.clients } };
      case 'pause': return this.#current.runtime.maintenancePause(person);
      case 'resume': return this.#current.runtime.maintenanceResume(person);
      case 'activate': {
        const closed = await this.close(); if (!closed.ok) return closed;
        const started = await this.#start(this.#path); if (!started.ok) return started;
        this.#current = started.value; return { ok: true, value: undefined };
      }
    }
  }
}
async function control(application: Application, server: KernelTransport, schemas: Schemas, endpoint: string): Promise<Result<void>> {
  const check = schemas.compile<Command>({ ...schema, $id: 'thetis://internal/maintenance/command', $ref: '#/$defs/command' });
  const ended = Promise.withResolvers<Result<void>>(); let busy = false;
  const send = (value: object): void => { process.send?.(value, undefined, {}, (error: Error | null) => { if (error) ended.resolve(failure('io', 'The kernel maintenance response could not be sent.')); }); };
  process.on('message', (value: unknown) => {
    if (!check(value) || Buffer.byteLength(JSON.stringify(value)) > 65536 || busy) { ended.resolve(failure('budget', 'The kernel maintenance control queue is full or invalid.')); return; }
    busy = true;
    void application.execute(value, server).then(result => {
      send({ id: value.id, ...result }); busy = false;
      if (value.method === 'stop') ended.resolve({ ok: true, value: undefined });
    }, () => { ended.resolve(failure('io', 'The kernel maintenance command failed.')); });
  });
  process.once('disconnect', () => { ended.resolve(failure('io', 'The kernel maintenance supervisor disconnected.')); });
  send({ ready: true, endpoint }); const result = await ended.promise;
  const closed = await application.close(); const stopped = await server.close();
  if (process.connected) process.disconnect();
  return !result.ok ? result : !closed.ok ? closed : stopped;
}
export async function host(start: Start, majors: readonly string[]): Promise<Result<void>> {
  const [path, endpoint, mode, administrator] = process.argv.slice(2);
  if (!process.send || !path || !endpoint || !administrator || mode !== 'probe' && mode !== 'serve') return failure('invalid-args', 'The kernel maintenance descriptors or arguments are invalid.');
  const schemas = new Schemas(); await schemas.load();
  const config = await configuration(path, schemas); if (!config.ok) return config;
  const probePath = join(dirname(path), 'probe.json');
  const probe = { ...config.value, targets: [] }; delete probe.trusted; delete probe.bootstrap;
  try { await writeFile(probePath, JSON.stringify(probe), { mode: 0o600 }); }
  catch { return failure('io', 'The private kernel probe configuration could not be written.'); }
  const application = await start(mode === 'probe' ? probePath : path); if (!application.ok) return application;
  const server = new KernelTransport(schemas, clock, majors); const opened = await server.open(endpoint); if (!opened.ok) { await application.value.close(); return opened; }
  return control(new Application(application.value, start, path, administrator), server, schemas, endpoint);
}
