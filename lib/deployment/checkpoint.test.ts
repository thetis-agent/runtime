/** Keep kernel recovery metadata atomic and free of resolved authority values; ADR 0019, GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '../schema/index.ts';
import { revision } from '../../test/runtime-fixture.ts';
import { saveCheckpoint, loadCheckpoint } from './checkpoint.ts';

await test('ADR-0019 checkpoint writes only neutral process plans and replaces inherited runtime authority', async () => {
  const root = await mkdtemp('/tmp/checkpoint-'); const schemas = new Schemas(); await schemas.load(); await mkdir(join(root, 'state'));
  const configured = await revision('provider-mock', 'service.ts');
  const target = { id: 'target', owner: '', scope: 'deployment', state: join(root, 'state'), entries: [], services: [],
    revision: { ...configured, plan: { ...configured.plan, secrets: { KEY: 'resolved-value' } } }, profile: { runtime: { token: 'credential-value' } } };
  const view = { state: 'LIVE', current: { n: 1, pins: {}, stateSnapshot: '', prefixRenderer: '1', at: 0 }, since: 0 };
  try {
    assert.ok((await saveCheckpoint(root, { version: 1, target, pins: configured.pins, view, state: target.state, endpoint: '/endpoint/service.sock' }, schemas)).ok);
    const file = (await readdir(root)).find(path => path.endsWith('.json')); assert.ok(file);
    const bytes = await readFile(join(root, file), 'utf8'); assert.equal(bytes.includes('resolved-value'), false); assert.equal(bytes.includes('credential-value'), false);
    const loaded = await loadCheckpoint(root, target.id, schemas); assert.ok(loaded.ok); assert.equal(loaded.value.view.current.n, 1);
    assert.equal(loaded.value.target.revision.plan['secrets'], undefined);
    assert.ok(!(await loadCheckpoint(root, 'different', schemas)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});
