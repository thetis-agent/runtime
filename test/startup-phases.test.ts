/** Observe startup only through the real inherited health boundary; GN-003. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from '@/test/provider-service.ts';
import { environmentProcess } from '@/test/environment-process.ts';
import { Process } from '@/kernel/boundary/process.ts';
await test('GN-003 startup phase measurements accompany actual ready health', async () => {
  const shared = await serviceFixture();
  try {
    const environment = await environmentProcess(shared, 'alice');
    try {
      assert.ok((await environment.process.probe()).ok);
      const health = await environment.process.control.call('health.probe', {}); assert.ok(health.ok);
      process.stdout.write(`${JSON.stringify({ measurement: 'environment-startup-phases', health: health.value })}\n`);
      assert.ok((await environment.process.stop('startup measurement')).ok);
      const warmed = await Process.start(environment.plan, shared.client('alice').token, environment.context); assert.ok(warmed.ok);
      try {
        assert.ok((await warmed.value.probe()).ok);
        const health = await warmed.value.control.call('health.probe', {}); assert.ok(health.ok);
        process.stdout.write(`${JSON.stringify({ measurement: 'environment-cached-startup-phases', health: health.value })}\n`);
      } finally { assert.ok((await warmed.value.stop('cached startup measurement')).ok); }
    } finally { await environment.close(); }
  } finally { await shared.close(); }
});
