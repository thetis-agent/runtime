/** Boot only configured verified generations and close their authority on shutdown; ADR 0012, GN-004. */
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/lib/deployment/index.ts';
import { Schemas, failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { clock } from '@/lib/events/index.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { Runtime } from '@/kernel/boundary/runtime.ts';
import type { RuntimeContext } from '@/kernel/boundary/runtime.ts';
import { Identity } from '@/kernel/identity/index.ts';
import { Journal } from '@/kernel/log/index.ts';
import { descriptor } from '@/lib/files/descriptor.ts';
import { Secrets } from '@/kernel/secrets/index.ts';
import { defaultAct } from '@/kernel/generations/default.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import type { Act } from '@/kernel/generations/act.ts';
import { origin } from '@/kernel/socket/origin.ts';
import { listen } from '@/lib/http/listen.ts';
import { defaultRecovery } from '@/lib/deployment/default-recover.ts';
import { exclusive, retireOrigin } from '@/lib/deployment/exclusive.ts';
import { evaluationBootstrap } from '@/lib/deployment/evaluation-bootstrap.ts';
import type { Evaluation } from '@/lib/deployment/evaluation-bootstrap.ts';
import { bootstrap } from '@/lib/deployment/bootstrap.ts';
import { watchAll } from '@/lib/deployment/work.ts';

export async function start(path: string): Promise<Result<{ runtime: Runtime; identity: Identity; close(): Promise<Result<void>> }>> {
  const schemas = new Schemas(); await schemas.load();
  const config = await configuration(path, schemas); if (!config.ok) return config;
  await mkdir(config.value.root, { recursive: true, mode: 0o700 });
  const recoveryJournal = join(config.value.root, 'observed.jsonl');
  const journal = await Journal.open(recoveryJournal, () => Date.now()); if (!journal.ok) return journal;
  const identity = new Identity(config.value.identity, () => Date.now());
  let evaluations: Evaluation | undefined;
  const trusted = config.value.trusted; let act: Act | undefined; let restored: (() => Promise<Result<void>>) | undefined;
  const defaultRoot = join(config.value.root, 'default'); await mkdir(defaultRoot, { recursive: true, mode: 0o700 });
  const replay = trusted ? await defaultRecovery(defaultRoot, recoveryJournal, schemas) : undefined;
  if (replay && !replay.ok) { await journal.value.close(); return replay; }
  const key = trusted ? await descriptor(trusted.keyFd, 32) : undefined;
  if (key && !key.ok) { await journal.value.close(); return key; }
  const sealed = key?.ok ? await Secrets.open(join(config.value.root, 'sealed'), key.value) : undefined;
  if (key?.ok) key.value.fill(0);
  if (sealed && !sealed.ok) { await journal.value.close(); return sealed; }
  const runtime = new Runtime({
    root: join(config.value.root, 'targets'),
    recoveryJournal,
    schemas, clock, identity, journal: journal.value,
    runner: new SandboxRunner(config.value.cgroup),
    ...(sealed?.ok ? { secrets: sealed.value } : {}),
    extension: evaluationExtension(() => evaluations, () => act)
  });
  let endpoint: Awaited<ReturnType<typeof listen>> | undefined; const watcher: { current?: Awaited<ReturnType<typeof watchAll>> } = {};
  const close = async (): Promise<Result<void>> => { const watched = watcher.current?.ok ? await watcher.current.value.close() : undefined; const stopped = endpoint?.ok ? await endpoint.value.close() : undefined; const closed = await runtime.close(); const evaluated = await evaluations?.close(); await journal.value.close(); return watched && !watched.ok ? watched : stopped && !stopped.ok ? stopped : evaluated && !evaluated.ok ? evaluated : closed; };
  if (trusted) {
    const prepared = await evaluationBootstrap({ root: join(config.value.root, 'execution'), journal: recoveryJournal, schemas, clock, runner: new SandboxRunner(config.value.cgroup),
      start: (account, services, ...args) => runtime.transient(account, services, ...args), endpoint: id => runtime.endpointDirectory(id), authority: () => runtime.emptyAuthority(), observe: (kind, data) => journal.value.observed('execution', kind, data) }, trusted);
    if (!prepared.ok) { await close(); return prepared; } evaluations = prepared.value;
    const administrator = identity.principal(trusted.administrator);
    if (!administrator || administrator.role !== 'admin') { await close(); return failure('forbidden', 'The default evaluation designation requires a configured administrator.'); }
    const configured = await defaultAct({ root: defaultRoot, schemas, journal: journal.value, runtime, administrator, now: () => Date.now() }, trusted, replay?.ok ? replay.value.view : undefined);
    if (!configured.ok) { await close(); return configured; } act = configured.value.act; restored = () => configured.value.ready();
  }
  for (const target of config.value.targets) { const started = await runtime.start(target, replay?.ok ? replay.value.targets.find(value => value.target.id === target.id) : undefined); if (!started.ok) { const closed = await close(); return closed.ok ? started : closed; } }
  let watched = config.value.work ?? [];
  if (config.value.bootstrap) {
    const assembled = await bootstrap(config.value.bootstrap, runtime, start, schemas);
    const checked = assembled.ok ? await configuration(config.value.bootstrap.output, schemas) : assembled;
    if (!checked.ok) { await close(); return checked; }
    watched = [...watched, ...checked.value.work ?? []];
    for (const target of checked.value.targets) { const started = await runtime.start(target); if (!started.ok) { await close(); return started; } }
  }
  if (restored) { const ready = await restored(); if (!ready.ok) { await close(); return ready; } }
  if (trusted && sealed?.ok && act) {
    endpoint = await listen(origin({ origin: trusted.origin, identity, schemas, secrets: sealed.value, act }), trusted.socket);
    if (!endpoint.ok) { await close(); return endpoint; }
  }
  const work = await watchAll({ ...config.value, work: watched }, runtime, start, schemas, async (target, result, changes, elapsedMs) => {
    const observed = await journal.value.observed(target, 'work.change', { hashes: changes.map(change => change.hash), elapsedMs, outcome: result.ok ? 'live' : 'refused' }, true);
    if (!observed.ok) process.stderr.write(`${JSON.stringify(observed)}\n`);
    if (!result.ok) { const reported = await journal.value.reported(target, 'work.refused', { error: result.error }); if (!reported.ok) process.stderr.write(`${JSON.stringify(reported)}\n`); }
  });
  watcher.current = work;
  if (!work.ok) { await close(); return work; }
  return { ok: true, value: { runtime, identity, close } };
}

function evaluationExtension(
  getEvaluation: () => Evaluation | undefined,
  getAct: () => Act | undefined
): NonNullable<RuntimeContext['extension']> {
  const submit: Operation = async (run, params) => {
    const act = getAct();
    return act ? act.submit(run, params)
      : failure('unsupported', 'No default evaluation authority is configured.');
  };
  return target => {
    const evaluation = getEvaluation()?.extension(target.id);
    const methods = new Map<Method, Operation>(evaluation?.methods);
    methods.set('results.submit', submit);
    return { capabilities: evaluation?.capabilities ?? [], methods };
  };
}

async function boot(path: string): ReturnType<typeof start> {
  const schemas = new Schemas(); await schemas.load(); const config = await configuration(path, schemas); if (!config.ok) return config;
  const lock = await exclusive(config.value.root, clock); if (!lock.ok) return lock;
  const reaped = await new SandboxRunner(config.value.cgroup).reap();
  const retired = reaped.ok && config.value.trusted ? await retireOrigin(config.value.root, config.value.trusted.socket) : reaped;
  const started = retired.ok ? await start(path) : retired;
  if (!started.ok) { await lock.value.close(); return started; }
  return { ok: true, value: { ...started.value, close: async () => { const closed = await started.value.close(); const released = await lock.value.close(); return closed.ok ? released : closed; } } };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const result = path ? await boot(path) : failure('invalid-args', 'The kernel requires a deployment configuration path.');
  if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; return; }
  process.stdout.write(`${JSON.stringify({ ok: true, value: { ready: true } })}\n`);
  await new Promise<void>(resolve => {
    const stop = (): void => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); resolve(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  const closed = await result.value.close();
  if (!closed.ok) { process.stderr.write(`${JSON.stringify(closed)}\n`); process.exitCode = 1; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
