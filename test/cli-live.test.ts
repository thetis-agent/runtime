/** Send from the shipped CLI while receiving its live content on the scoped direct stream; ADR 0019. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './provider-service.ts';
import { environmentProcess } from './environment-process.ts';
import { gatewayProcess } from './gateway-process.ts';
import { isObject } from '../lib/schema/index.ts';

await test('CLI live output arrives through the environment mount while the kernel observes only turn metadata', async () => {
  const shared = await serviceFixture(1); assert.ok((await shared.process.probe()).ok);
  const environment = await environmentProcess(shared, 'alice', true);
  const created = await environment.process.invoke('session.create', { surface: 'cli' }); assert.ok(created.ok && isObject(created.value)); const id = created.value['id']; assert.ok(typeof id === 'string');
  const cli = await gatewayProcess(shared, environment, 'alice', 'cli', ['send', id, 'Hello'], 'main.ts');
  try {
    const stdout = cli.process.running.process.stdout; assert.ok(stdout); const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of stdout) { const value: unknown = chunk; assert.ok(Buffer.isBuffer(value)); bytes += value.length; assert.ok(bytes < 1048576); chunks.push(value); }
    assert.equal((await cli.process.running.exited).code, 0);
    const output = Buffer.concat(chunks).toString('utf8'); assert.ok(output.includes('session.events')); assert.ok(output.includes('Hello.')); assert.ok(output.includes('"type":"end"'));
    const rows = await environment.rows(); assert.ok(rows.includes('turn.start')); assert.ok(rows.includes('turn.end')); assert.ok(!rows.includes('Hello.'));
  } finally { await cli.close(); await environment.close(); await shared.close(); }
});
