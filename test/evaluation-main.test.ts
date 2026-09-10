/** Exercise delegated evaluator operations through the actual booted kernel and generation driver; EV-006. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/schema/index.ts';
import { evaluationMain } from '@/test/evaluation-main.ts';
await test('EV-006 production evaluator delegation uses ordinary accounts, real candidate generations and isolated scorer observations', async () => {
  const fixture = await evaluationMain();
  try {
    const endpoint = join(fixture.root, 'targets', createHash('sha256').update(fixture.source).digest('base64url'), 'runs/public');
    const descriptor = await open(endpoint, 'r'); const socket = await connect(`/proc/self/fd/${String(descriptor.fd)}/current.sock`); await descriptor.close(); assert.ok(socket.ok);
    try {
      assert.ok((await send(socket.value, { v: '1', method: 'evaluate', candidate: fixture.candidate })).ok);
      const result = await socketFrames(socket.value).next(); assert.ok(!result.done && result.value.ok, JSON.stringify(result));
      assert.ok(isObject(result.value.value) && result.value.value['ok'] === true, JSON.stringify(result.value));
      const rows = await readFile(join(fixture.root, 'observed.jsonl'), 'utf8');
      assert.equal(rows.split('\n').filter(row => row.includes('"generation.initial"')).length, 9);
      assert.equal(rows.split('\n').filter(row => row.includes('"evaluation.outcome"')).length, 6);
      assert.match(rows, /"results.accepted"/u); assert.match(rows, /"provenance":"reviewed-reported"/u);
      assert.ok(!rows.includes('production-fixture-seed'));
    } finally { socket.value.destroy(); }
  } finally { await fixture.close(); }
});
