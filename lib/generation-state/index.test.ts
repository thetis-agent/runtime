/** Prove that reported snapshots cannot choose recovery state or undo a fence; ADR 0014, ADR 0025. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generationDriver } from '../../test/generation-driver.ts';
import { Schemas } from '../schema/index.ts';
import { recover } from './index.ts';

await test('ADR-0025 recovery takes observed commitment intent and ignores candidate-authored snapshots', async () => {
  const f = await generationDriver(); const schemas = new Schemas(); await schemas.load(); const path = join(f.root, 'observations.jsonl');
  try {
    await f.advance(5); const intended = f.machine.view;
    await appendFile(path, `${JSON.stringify({ provenance: 'candidate-reported', target: 'person:a', at: 0, kind: 'generation.transition', data: { snapshot: { current: { n: 999 }, state: 'LIVE' } } })}\n`);
    assert.deepEqual(await recover(path, 'person:a', schemas), { ok: true, value: intended });
    await f.move({ event: 'failed', reason: 'recovery after commitment' });
    await f.move({ event: 'restored', reason: 'fresh epoch', restored: true, probed: true });
    const latest = await recover(path, 'person:a', schemas); assert.ok(latest.ok); assert.equal(latest.value?.current.n, 3);
    await appendFile(path, `${JSON.stringify({ provenance: 'kernel-observed', target: 'person:a', at: 0, kind: 'generation.transition', data: { snapshot: intended } })}\n`);
    const regressed = await recover(path, 'person:a', schemas); assert.ok(!regressed.ok); assert.equal(regressed.error.code, 'fenced');
  } finally { await f.close(); }
});
