/** Verify that private evaluation completes through inherited delegation and reaches the trusted act; EV-001. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { evaluatorService } from '@/test/evaluator-service.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/result/index.ts';
import { reviewer } from '@/test/default-act.ts';

await test('EV-001 registered evaluator submits real loop outcomes and exposes only aggregates', async () => {
  const f = await evaluatorService();
  try {
    assert.ok((await f.process.probe()).ok);
    const connection = await connect(join(f.root, 'endpoint/service.sock')); assert.ok(connection.ok);
    try {
      assert.ok((await send(connection.value, { v: '1', method: 'evaluate', candidate: f.settings.plan.identities.candidate, future: true })).ok);
      const response = await socketFrames(connection.value).next(); assert.ok(!response.done && response.value.ok);
      assert.ok(isObject(response.value.value) && response.value.value['ok'] === true, JSON.stringify(response.value));
      assert.ok(!JSON.stringify(response.value.value).includes('private-task')); assert.ok(!JSON.stringify(response.value.value).includes('fixture-private-seed'));
      const prepared = f.act.act.prepare(reviewer, { digest: f.settings.plan.identities.candidate, baseline: 1 }); assert.ok(prepared.ok, JSON.stringify(prepared));
    } finally { connection.value.destroy(); }
  } finally { await f.close(); }
});
