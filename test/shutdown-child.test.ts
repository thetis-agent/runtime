/** Verify handler shutdown, child EOF and retired endpoints across restart; TE-023, ADR 0046. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, realpath, readdir, open } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { runtimeFixture, people } from './runtime-fixture.ts';
import { snapshot } from '../lib/snapshots/index.ts';
import { connect } from '../lib/ndjson/socket.ts';
import type { Entry } from '../lib/package-loader/types.ts';
import { buildTree } from '../lib/artifacts/build.ts';

async function childSocket(directory: string) {
  const handle = await open(directory, 'r');
  try { return await connect(`/proc/self/fd/${String(handle.fd)}/child.sock`); } finally { await handle.close(); }
}

for (const migrate of ['stop', 'shared'] satisfies ('stop' | 'shared')[]) await test(`TE-023 ${migrate} restart waits for actual handler shutdown then kills its surviving child at the injected deadline`, async () => {
  const f = await runtimeFixture();
  try {
    const person = people[0]; assert.ok(person); const target = await f.environment(person.id);
    const source = join(f.root, 'handler'); await mkdir(source);
    await writeFile(join(source, 'index.ts'), await readFile(new URL('./fixtures/shutdown-handler.ts', import.meta.url)));
    await writeFile(join(source, 'shutdown-child.ts'), await readFile(new URL('./fixtures/shutdown-child.ts', import.meta.url)));
    const entry: Entry = { path: '/handler/index.ts', state: '/state/handler', settings: {}, manifest: { name: 'child-holder', version: '1.0.0', requires: {}, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } } } };
    await writeFile(join(source, 'package.json'), JSON.stringify(entry.manifest)); assert.ok(await buildTree(source, source)); const hash = await snapshot(source); assert.ok(hash.ok);
    target.entries = [...target.entries, entry]; target.profile['entries'] = target.entries;
    target.revision = { ...target.revision, migrate, pins: { ...target.revision.pins, handler: { source, hash: hash.value, mount: '/handler' } } };
    assert.ok((await f.runtime.start(target)).ok);
    const endpoint = f.runtime.endpoint(person.id); assert.ok(endpoint.ok); const runs = dirname(dirname(await realpath(endpoint.value)));
    const initial = (await readdir(runs)).filter(name => name.startsWith('1-initial-')); assert.equal(initial.length, 1); const first = initial[0]; assert.ok(first); const directory = join(runs, first, 'endpoint');
    const child = await childSocket(directory); assert.ok(child.ok, JSON.stringify({ child, rows: await f.rows(), directory, files: await readdir(directory) }));
    const gone = new Promise<void>(resolve => { child.value.once('close', () => { resolve(); }); });
    const started = Promise.withResolvers<undefined>();
    const watcher = watch(join(dirname(directory), 'state/handler'), (_event, name) => { if (name === 'shutdown-started') started.resolve(undefined); });
    try {
      const switching = f.runtime.switch(person, target, 1);
      assert.equal(await Promise.race([started.promise.then(() => true), switching.then(() => false)]), true, 'The real shutdown hook must begin before the switch finishes.');
      f.clock.advance(30000); const switched = await switching; assert.ok(switched.ok, JSON.stringify(switched));
      await gone; await assert.rejects(() => childSocket(directory), { code: 'ENOENT' });
      const rows = await f.rows(); assert.match(rows, /"kind":"process.shutdown".*"outcome":"killed"/u);
      if (migrate === 'stop') assert.match(rows, /"action":"shutdown".*shutdown-started/u);
      const status = f.runtime.status(person, person.id); assert.ok(status.ok); assert.equal(status.value['generation'], 2); assert.equal(status.value['state'], 'LIVE');
    } finally { watcher.close(); child.value.destroy(); }
  } finally { await f.close(); }
});
