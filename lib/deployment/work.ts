/** Bind person work watchers to injected generation drivers and isolated review processes; GN-001–003. */
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LiveWork } from '../profile/work-live.ts';
import type { Work } from '../profile/work.ts';
import { describe } from '../package-loader/discovery-client.ts';
import type { Captured } from '../package-loader/types.ts';
import { writeDeployment } from '../profile/orchestrate.ts';
import { clock } from '../events/index.ts';
import type { Clock } from '../events/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
import { validators } from '../evaluation/index.ts';
import { validator } from '../package-loader/index.ts';
import type { Entry } from '../package-loader/types.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Configuration, ConfiguredTarget } from './index.ts';
import type { Launch } from './bootstrap.ts';
import type { Principal, Deployment, Target, Work as WorkSetting } from './types.ts';
export type WorkSettings = WorkSetting;
export interface Driver {
  status(person: Principal, target: string): Result<Record<string, unknown>>;
  switch(person: Principal, target: ConfiguredTarget, baseline: number): Promise<Result<void>>;
}
export type Observer = (target: string, result: Result<void>, changes: readonly Work[], elapsedMs: number) => void | Promise<void>;

export async function review(target: ConfiguredTarget, setting: WorkSettings, config: Configuration, launch: Launch, schemas: Schemas): Promise<Result<Captured>> {
  await mkdir(setting.discoveryRoot, { recursive: true, mode: 0o700 }); const root = await mkdtemp(join(setting.discoveryRoot, 'p-'));
  const state = join(root, 'initial');
  const reviewed: ConfiguredTarget = { ...target, state, id: createHash('sha256').update(root).digest('hex').slice(0, 16), environment: false, services: [], profile: {
    roots: ['/opt/thetis-runtime'], state: '/state', setup: { entries: target.entries, profile: target.profile['profile'] ?? {}, provided: target.profile['provided'] ?? {}, spaces: target.profile['spaces'] ?? [], excluded: [] }
  }, revision: { ...target.revision, plan: { ...target.revision.plan, entry: setting.discoveryEntry, args: [], network: 'none' }, mounts: [] } };
  delete reviewed.registration;
  const deployment: Deployment = { version: 1, root, cgroup: config.cgroup, identity: config.identity, targets: [reviewed] };
  try {
    await mkdir(state, { mode: 0o700 });
    const path = join(root, 'configuration.json'); const written = await writeDeployment(path, deployment); if (!written.ok) return written;
    const started = await launch(path); if (!started.ok) return started;
    let captured: Result<Captured> = failure('io', 'The work review did not return a registration.'); let closed: Result<void>;
    try { const endpoint = started.value.runtime.endpoint(reviewed.id); captured = endpoint.ok ? await describe(endpoint.value, schemas) : endpoint; }
    finally { closed = await started.value.close(); }
    return closed.ok ? captured : closed;
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function watchWork(setting: WorkSettings, target: ConfiguredTarget, config: Configuration, driver: Driver, launch: Launch, schemas: Schemas, observe: Observer, time: Clock = clock): Promise<Result<LiveWork>> {
  const person = config.identity.people.find(person => person.id === target.owner);
  if (!person || target.id !== setting.target || target.scope !== 'person' || target.environment === false) return failure('forbidden', 'The work watcher requires its configured person-owned environment.');
  return LiveWork.open(target, setting.root, setting.cache, time, schemas, {
    describe: target => review(target, setting, config, launch, schemas),
    switch: async target => {
      const status = driver.status(person, target.id); if (!status.ok) return status;
      const baseline = status.value['generation']; if (typeof baseline !== 'number') return failure('io', 'The environment generation is absent from its observed status.');
      return driver.switch(person, target, baseline);
    },
    observe: (result, changes, elapsedMs) => observe(target.id, result, changes, elapsedMs)
  });
}

async function current(input: unknown, schemas: Schemas): Promise<Result<ConfiguredTarget>> {
  const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
  if (!isObject(schema)) throw new Error('The committed deployment schema is invalid.');
  validators(schemas);
  if (!schemas.compile<Target>({ ...schema, $id: 'thetis://internal/work-target/1', $ref: '#/$defs/target' })(input)) return failure('invalid-args', 'The active work target violates its schema.');
  const check = await validator<Entry>(schemas, 'entry'); const entries: Entry[] = [];
  for (const entry of input.entries) { if (!check(entry)) return failure('invalid-args', 'The active package entry violates its schema.'); entries.push(entry); }
  return { ok: true, value: { ...input, entries } };
}
export async function watchAll(config: Configuration, driver: Driver & { current(id: string): Result<unknown> }, launch: Launch, schemas: Schemas, observe: Observer): Promise<Result<{ close(): Promise<Result<void>> }>> {
  const watchers: LiveWork[] = [];
  const close = async (): Promise<Result<void>> => {
    let result: Result<void> = { ok: true, value: undefined };
    for (const watcher of watchers) { const closed = await watcher.close(); if (!closed.ok) result = closed; }
    return result;
  };
  for (const setting of config.work ?? []) {
    const selected = driver.current(setting.target); const target = selected.ok ? await current(selected.value, schemas) : selected;
    const opened = target.ok ? await watchWork(setting, target.value, config, driver, launch, schemas, observe) : target;
    if (!opened.ok) { const closed = await close(); return closed.ok ? opened : closed; }
    watchers.push(opened.value);
  }
  return { ok: true, value: { close } };
}
