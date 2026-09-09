/** Interrupt actual synchronous initialization without blocking environment health; TE-021–022. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Initializer } from './initialization.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { discover } from '../../lib/package-loader/index.ts';
import type { Setup } from '../../lib/package-loader/types.ts';

async function fixture(bad: string) {
  const root = await mkdtemp('/tmp/initialization-'); const packages = join(root, 'packages'); await mkdir(packages);
  for (const [name, code] of [['good', 'async init(_profile, ctx) { ctx.register({ requires: {}, provides: { "service/example": "1.0.0" } }); }'], ['late', bad]]) {
    assert.ok(name); assert.ok(code); const path = join(packages, name); await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', requires: {}, provides: {}, settings: { type: 'object', additionalProperties: false }, envelope: { requires: [], provides: ['service/example'], spawn: { scope: 'person', network: 'none' } } }));
    await writeFile(join(path, 'index.ts'), `/** Script an initialization edge; TE-022. */\nexport const stages = { ${code} };\n`);
  }
  const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const entries = await discover(packages, join(root, 'state'), {}, schemas); assert.ok(entries.ok, JSON.stringify(entries));
  const setup: Setup = { entries: entries.value, profile: {}, provided: {}, spaces: [], excluded: [] };
  return { schemas, clock, setup, close: () => rm(root, { recursive: true, force: true }) };
}

await test('TE-022 a synchronous infinite init becomes inert while the environment monitor stays healthy', async () => {
  const f = await fixture('init(_profile, ctx) { ctx.emit({ content: [{ type: "text", text: "entered" }] }); for (;;) {} }'); const late = Promise.withResolvers<undefined>();
  const initializer = new Initializer(f.clock, f.schemas, value => { if (value.type === 'notice' && value.source === 'late@1.0.0') late.resolve(undefined); });
  try {
    const started = initializer.start(f.setup); assert.ok(await Promise.race([late.promise.then(() => true), started.then(() => false)]));
    assert.deepEqual(initializer.status(), { ready: true, initializing: 'late@1.0.0' });
    f.clock.advance(10000); const result = await started; assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value.sources, ['good@1.0.0']);
    assert.deepEqual(result.value.gaps, ['late 1.0.0 requires cap/init.within-probe *. Nothing in this profile provides it. No configured registry provides it.']);
    assert.equal(result.value.registrations.size, 1); assert.match(result.value.failures.get('late@1.0.0') ?? '', /probe budget/u);
    assert.equal(initializer.status().ready, true);
  } finally { await initializer.stop(); await f.close(); }
});

await test('TE-021 independent initializations register identical names and reject an out-of-envelope package', async () => {
  const f = await fixture('async init(_profile, ctx) { ctx.register({ requires: { "secret/forbidden": "*" }, provides: {} }); }');
  const registrations: unknown[] = [];
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const initializer = new Initializer(f.clock, f.schemas);
      try {
        const result = await initializer.start(f.setup); assert.ok(result.ok, JSON.stringify(result));
        assert.deepEqual(result.value.sources, ['good@1.0.0']); assert.match(result.value.failures.get('late@1.0.0') ?? '', /outside the declared envelope/u);
        registrations.push([...result.value.registrations]);
      } finally { await initializer.stop(); }
    }
    assert.deepEqual(registrations[0], registrations[1]);
  } finally { await f.close(); }
});

await test('TE-022 an actual worker crash after ready makes health fail and never silently reinitializes', async () => {
  const f = await fixture('init() { setImmediate(() => { throw new Error("background failure"); }); }');
  const notices: string[] = []; const initializer = new Initializer(f.clock, f.schemas, message => { notices.push(message.type); });
  try {
    assert.ok((await initializer.start(f.setup)).ok);
    const finished = await initializer.finished(); assert.ok(!finished.ok); assert.equal(finished.error.code, 'io');
    assert.equal(initializer.status().ready, false); assert.equal(notices.filter(type => type === 'ready').length, 1);
    assert.ok(!(await initializer.start(f.setup)).ok);
  } finally { await initializer.stop(); await f.close(); }
});

await test('TE-021 every shipped package initializes twice with identical registration and no vendor access', async () => {
  const root = await mkdtemp('/tmp/shipped-init-'); const schemas = new Schemas(); await schemas.load();
  const discovered = await discover(new URL('..', import.meta.url).pathname, root, {}, schemas); assert.ok(discovered.ok, JSON.stringify(discovered));
  try {
    for (const entry of discovered.value) {
      const rows: unknown[] = [];
      for (let run = 0; run < 2; run++) {
        const initializer = new Initializer(new ManualClock(), schemas);
        try {
          const result = await initializer.start({ entries: [entry], profile: {}, provided: {}, spaces: [], excluded: [] });
          assert.ok(result.ok, JSON.stringify(result)); assert.deepEqual(result.value.gaps, []);
          assert.deepEqual(result.value.sources, [`${entry.manifest.name}@${entry.manifest.version}`]); rows.push([...result.value.registrations]);
          if (Object.keys(entry.manifest.provides).some(name => name.startsWith('service/'))) assert.equal(result.value.registrations.get(`${entry.manifest.name}@${entry.manifest.version}`)?.spawn?.length, 1);
        } finally { await initializer.stop(); }
      }
      assert.deepEqual(rows[0], rows[1], entry.manifest.name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
