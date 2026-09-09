/** Keep package identity and registration outside its returned payloads; ADR 0016, TE-032. */
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { failure, isObject } from '../schema/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import type { Stage } from '../events/stages.ts';
import { frozen } from '../events/stages.ts';
import { envelope } from '../semver-match/index.ts';
import type { Notice } from '../../contracts/turn-events/types.ts';
import type { Entry, Setup, Registration, WorkerMessage } from './types.ts';
import { validator } from './index.ts';

type FunctionValue = (...args: unknown[]) => unknown;
const callable = (value: unknown): value is FunctionValue => typeof value === 'function';
export type Send = (message: WorkerMessage) => void;

export async function load(entry: Entry, setup: Setup, schemas: Schemas, send: Send): Promise<Result<Stage, 'invalid-args' | 'envelope' | 'io'>> {
  const source = `${entry.manifest.name}@${entry.manifest.version}`;
  try {
    await mkdir(entry.state, { recursive: true });
    const module: unknown = await import(pathToFileURL(entry.path).href);
    if (!isObject(module) || !isObject(module['stages'])) return failure('invalid-args', `${source} does not export stages.`);
    const exported = module['stages'];
    const context = await initialization(entry, setup, schemas, send);
    const init = module['init'] ?? exported['init'];
    if (init !== undefined && !callable(init)) return failure('invalid-args', `${source} exports an invalid init.`);
    if (callable(init) && await init(frozen(setup.profile), Object.freeze({ ...context.value, register: context.register, emit: context.emit })) !== undefined) return failure('invalid-args', `${source} init returned a value outside its contract.`);
    const registration = context.registration(); if (!registration.ok) return registration;
    if (registration.value) send({ type: 'registration', source, registration: registration.value });
    return normalize(source, exported, Object.keys(entry.manifest.provides).some(name => name.startsWith('mount/')));
  } catch { return failure('io', `${source} could not initialize.`); }
}

async function initialization(entry: Entry, setup: Setup, schemas: Schemas, send: Send) {
  const source = `${entry.manifest.name}@${entry.manifest.version}`;
  const check = await validator<Registration>(schemas, 'registration');
  let registration: Result<Registration | undefined, 'envelope' | 'invalid-args'> = { ok: true, value: undefined }; let registered = false;
  return {
    registration: () => registration,
    value: frozen({ settings: entry.settings, provided: setup.provided, spaces: setup.spaces, state: entry.state }),
    // Functions are attached separately because structuredClone deliberately rejects executable values.
    register: (value: unknown): Result<void, 'envelope' | 'invalid-args'> => {
      if (registered) { registration = failure('envelope', `${source} registered more than once.`); return registration; } registered = true;
      if (!check(value)) { registration = failure('invalid-args', `${source} registered an invalid shape.`); return registration; }
      const requires = envelope(Object.keys(value.requires), entry.manifest.envelope.requires); const provides = envelope(Object.keys(value.provides), entry.manifest.envelope.provides);
      const spawn = value.spawn?.every(item => item['scope'] === entry.manifest.envelope.spawn.scope && item['network'] === entry.manifest.envelope.spawn.network) ?? true;
      if (!requires.ok || !provides.ok || !spawn) { registration = !requires.ok ? requires : !provides.ok ? provides : failure('envelope', `${source} registered a spawn outside its envelope.`); return registration; }
      registration = { ok: true, value: structuredClone(value) }; return { ok: true, value: undefined };
    },
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
  const call = exported['call']; if (callable(call)) stage.call = (request, sink) => Promise.resolve(call(request, sink));
  const retrieve = exported['retrieve']; if (callable(retrieve)) stage.retrieve = request => Promise.resolve(retrieve(request));
  const shutdown = exported['shutdown']; if (callable(shutdown)) stage.shutdown = async () => { await shutdown(); };
  const section = exported['section']; if (section !== undefined && section !== 'harness' && section !== 'history') return failure('invalid-args', `${source} selects an immutable context section.`);
  if (section !== undefined) stage.section = section;
  return gateway && stage.call ? failure('invalid-args', `${source} is a gateway; call is an own hook.`) : { ok: true, value: stage };
}
