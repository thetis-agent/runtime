/** Assemble real pinned processes and migrations for the generation driver; GN-001–006. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Revision } from '../kernel/generations/prepare.ts';
import { Driver } from '../kernel/generations/driver.ts';
import { Identity } from '../kernel/identity/index.ts';
import type { Principal } from '../kernel/identity/index.ts';
import { Journal } from '../kernel/log/index.ts';
import type { Context } from '../kernel/boundary/process.ts';
import type { Method } from '../contracts/kernel-socket/types.ts';
import type { Operation } from '../kernel/socket/index.ts';
import { Schemas } from '../lib/schema/index.ts';
import { ManualClock } from '../lib/events/index.ts';
import { SandboxRunner } from '../lib/sandbox-runner/index.ts';
import type { Mount } from '../lib/sandbox-runner/index.ts';
import { snapshot } from '../lib/snapshots/index.ts';
import { connect } from '../lib/ndjson/socket.ts';

const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
export const person: Principal = { id: 'alice', role: 'user', projects: [], observeOthers: false };

async function revision(root: string, name: string, mode: string, version: number, migrate: boolean): Promise<Revision> {
  const source = join(root, name); await mkdir(source);
  const entry = (await readFile(new URL('./fixtures/controlled-process.ts', import.meta.url), 'utf8')).replaceAll('../../lib/', `${repository}/lib/`).replaceAll('../../contracts/', `${repository}/contracts/`);
  await writeFile(join(source, 'index.ts'), entry); await writeFile(join(source, 'version'), name);
  await writeFile(join(source, 'migrate.ts'), `/** Apply the fixture state version on a private copy; GN-006. */\nimport { writeFile } from 'node:fs/promises';\nawait writeFile('/state/value.json', JSON.stringify({version:${String(version)}}));\nif (process.argv[2] === 'fail') process.exitCode = 1;\n`);
  const hash = await snapshot(source); assert.ok(hash.ok);
  return {
    plan: { name: 'fixture', version: `${String(version)}.0.0`, entry: '/revision/index.ts', args: [mode, '/endpoint/private.sock', 'shared'], cwd: '/state' },
    pins: { entry: { source, hash: hash.value, mount: '/revision' } },
    mounts: [
      ...['lib', 'contracts', 'node_modules'].map((name): Mount => ({ source: `${repository}/${name}`, path: `${repository}/${name}`, mode: 'ro' })),
      { source: join(root, 'work'), path: '/work', mode: 'rw', maximumBytes: 67108864 }
    ], stateMount: '/state', endpointMount: '/endpoint', socketName: 'private.sock', quotaBytes: 67108864,
    formats: [{ path: 'value.json', schema: { type: 'object', required: ['version'], properties: { version: { const: version } } } }],
    migrations: migrate ? [{ entry: '/revision/migrate.ts', args: [] }] : [], migrate: 'stop'
  };
}

export async function processGeneration(mode = 'healthy') {
  const root = await mkdtemp('/tmp/generation-process-'); await mkdir(join(root, 'state')); await mkdir(join(root, 'work'));
  await writeFile(join(root, 'state/value.json'), JSON.stringify({ version: 1 }));
  const clock = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  const journal = await Journal.open(join(root, 'observed.jsonl'), () => clock.now()); assert.ok(journal.ok);
  const identity = new Identity({ people: [person], authorities: {}, bindings: [] }, () => clock.now());
  const probing = Promise.withResolvers<undefined>();
  const context: Context = { target: 'alice', identity, schemas, clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: {
    methods: new Map<Method, Operation>([
      ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
      ['session.submit', () => Promise.resolve({ ok: true, value: null })],
      ['profile.get', run => { if (run.generation === 2) probing.resolve(undefined); return Promise.resolve({ ok: true, value: {} }); }]
    ]), notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined })
  } };
  const old = await revision(root, 'old', 'healthy', 1, false); const next = await revision(root, 'new', mode, 2, true);
  const hash = old.pins['entry']?.hash; assert.ok(hash);
  const started = await Driver.start({ root: join(root, 'target'), owner: person.id, context }, old, join(root, 'state'), { n: 1, pins: { entry: hash }, stateSnapshot: '', prefixRenderer: '1', at: 0 }); assert.ok(started.ok, JSON.stringify(started));
  return { root, driver: started.value, next, clock, identity, probing: probing.promise, rows: () => readFile(join(root, 'observed.jsonl'), 'utf8'), async close() {
    const stopped = await started.value.process.stop('test complete'); await journal.value.close(); await rm(root, { recursive: true, force: true }); assert.ok(stopped.ok, JSON.stringify(stopped));
  } };
}

export async function endpointVersion(path: string): Promise<string> {
  const socket = await connect(path); assert.ok(socket.ok);
  try {
    let text = ''; socket.value.write('version');
    for await (const chunk of socket.value) { const bytes: unknown = chunk; assert.ok(Buffer.isBuffer(bytes)); text += bytes.toString(); assert.ok(text.length < 64); }
    return text;
  } finally { socket.value.destroy(); }
}
