/** Keep transient endpoints private and cleanup idempotent before and after acceptance; KS-001. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { privateEndpoint } from './private.ts';
import { connect } from '../ndjson/socket.ts';

await test('KS-001 a private endpoint closes its listener after one peer and removes its directory', async () => {
  const opened = await privateEndpoint(); assert.ok(opened.ok);
  assert.equal((await stat(dirname(opened.value.path))).mode & 0o777, 0o700);
  const connected = await connect(opened.value.path); assert.ok(connected.ok);
  const accepted = await opened.value.accepted; assert.ok(accepted.ok);
  assert.ok(!(await connect(opened.value.path)).ok);
  connected.value.destroy(); const closed = opened.value.close(); assert.equal(opened.value.close(), closed); assert.ok((await closed).ok);
  await assert.rejects(stat(dirname(opened.value.path)), { code: 'ENOENT' });
});

await test('KS-001 cleanup before acceptance releases the pending peer without a timer', async () => {
  const opened = await privateEndpoint(); assert.ok(opened.ok);
  assert.ok((await opened.value.close()).ok); const accepted = await opened.value.accepted; assert.ok(!accepted.ok); assert.equal(accepted.error.code, 'io');
  await assert.rejects(stat(dirname(opened.value.path)), { code: 'ENOENT' });
});
