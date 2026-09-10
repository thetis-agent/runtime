/** Keep package identity and registration outside its returned payloads; ADR 0016, TE-032. */
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import type { Stage } from '@/lib/events/stages.ts';
import { frozen } from '@/lib/events/stages.ts';
import { Register } from './registration.ts';
import type { Notice } from '@/contracts/turn-events/types.ts';
import type { Entry, Setup, Registration, WorkerMessage } from './types.ts';
import { validator } from './index.ts';
import { stageService } from '@/lib/service/tool-client.ts';

type FunctionValue = (...args: unknown[]) => unknown;
const callable = (value: unknown): value is FunctionValue => typeof value === 'function';
export type Send = (message: WorkerMessage) => void;

export async function load(entry: Entry, setup: Setup, schemas: Schemas, send: Send): Promise<Result<Stage, 'invalid-args' | 'envelope' | 'io'>> {
  const source = `${entry.manifest.name}@${entry.manifest.version}`;
  let close: (() => void) | undefined;
  try {
    await mkdir(entry.state, { recursive: true });
    const module: unknown = await import(pathToFileURL(entry.path).href);
    if (!isObject(module) || !isObject(module['stages'])) return failure('invalid-args', `${source} does not export stages.`);
    const exported = module['stages'];
    const context = await initialization(entry, setup, schemas, send);
    close = () => { context.service.close(); };
    const init = module['init'] ?? exported['init'];
    if (init !== undefined && !callable(init)) return failure('invalid-args', `${source} exports an invalid init.`);
    if (callable(init) && await init(frozen(setup.profile), Object.freeze({ ...context.value, register: context.register, emit: context.emit, callService: context.service.call })) !== undefined) return failure('invalid-args', `${source} init returned a value outside its contract.`);
    const registration = context.registration(module['spawn']); if (!registration.ok) return registration;
    if (registration.value) send({ type: 'registration', source, registration: registration.value });
    const stage = normalize(source, exported, Object.keys(entry.manifest.provides).some(name => name.startsWith('mount/')));
    if (stage.ok) { const shutdown = stage.value.shutdown; stage.value.shutdown = async () => { context.service.close(); await shutdown?.(); }; close = undefined; }
    return stage;
  } catch { return failure('io', `${source} could not initialize.`); }
  finally { close?.(); }
}

async function initialization(entry: Entry, setup: Setup, schemas: Schemas, send: Send) {
  const source = `${entry.manifest.name}@${entry.manifest.version}`;
  const check = await validator<Registration>(schemas, 'registration');
  const register = new Register(entry, check);
  return {
    service: stageService(entry, setup, schemas),
    registration: (spawn: unknown) => register.finish(spawn),
    value: frozen({ settings: entry.settings, provided: setup.provided, spaces: setup.spaces, state: entry.state }),
    // Functions are attached separately because structuredClone deliberately rejects executable values.
    register: (value: unknown) => register.register(value),
    emit: (value: unknown): void => {
      if (!isObject(value)) throw new Error('A notice must be an object.');
      const notice = { ...value, source };
      if (!schemas.validator<Notice>('turn-events', 'notice')(notice)) throw new Error('The notice violates its contract.');
      send({ type: 'notice', source, notice });
    }
  };
}

function normalize(source: string, exported: Record<string, unknown>, gateway: boolean): Result<Stage, 'invalid-args'> {
  const stage: Stage = { source, gateway };
  for (const name of ['observe', 'context', 'offer', 'call', 'retrieve', 'shutdown']) if (exported[name] !== undefined && !callable(exported[name])) return failure('invalid-args', `${source} exports an invalid ${name} hook.`);
  const observe = exported['observe']; if (callable(observe)) stage.observe = event => observe(event);
  const context = exported['context']; if (callable(context)) stage.context = (append, value) => context(append, value);
  const offer = exported['offer']; if (callable(offer)) stage.offer = request => Promise.resolve(offer(request));
  const call = exported['call']; if (callable(call)) stage.call = (request, sink, signal) => Promise.resolve(call(request, sink, signal));
  const retrieve = exported['retrieve']; if (callable(retrieve)) stage.retrieve = request => Promise.resolve(retrieve(request));
  const shutdown = exported['shutdown']; if (callable(shutdown)) stage.shutdown = async () => { await shutdown(); };
  const section = exported['section']; if (section !== undefined && section !== 'harness' && section !== 'history') return failure('invalid-args', `${source} selects an immutable context section.`);
  if (section !== undefined) stage.section = section;
  return gateway && stage.call ? failure('invalid-args', `${source} is a gateway; call is an own hook.`) : { ok: true, value: stage };
}
