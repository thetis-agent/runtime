/** Prove egress adds only a private route and cannot connect to kernel loopback; ADR 0029. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { readlink } from 'node:fs/promises';
import { SandboxRunner } from './index.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { isObject } from '@/lib/schema/index.ts';

async function probe(network: 'none' | 'egress', port: number): Promise<Record<string, unknown>> {
  const pair = await socketPair(); assert.ok(pair.ok);
  try {
    const result = await new SandboxRunner('/cgroup').start({ name: 'network-fixture', version: '1.0.0', entry: '/entry.ts', args: [String(port)], cwd: '/tmp', socket: pair.value.client, token: 'network-test', network,
      mounts: [{ source: new URL('../../test/fixtures/sandbox-network.ts', import.meta.url).pathname, path: '/entry.ts', mode: 'ro' }] });
    assert.ok(result.ok, JSON.stringify(result)); let output = ''; let errors = '';
    result.value.process.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16384) result.value.process.kill('SIGKILL'); });
    result.value.process.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); if (errors.length > 16384) result.value.process.kill('SIGKILL'); });
    const exit = await result.value.exited; assert.equal(exit.code, 0, errors); assert.ok((await result.value.dispose()).ok);
    const value: unknown = JSON.parse(output); assert.ok(isObject(value)); return value;
  } finally { await pair.value.close(); }
}
await test('ADR 0029 egress configures a private default route while none remains isolated', async () => {
  let connections = 0; const server = createServer(socket => { connections++; socket.end(); });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await new Promise<void>((resolve, reject) => { const client = createConnection(address.port, '127.0.0.1'); client.once('error', reject); client.once('end', resolve); });
    assert.equal(connections, 1);
    const none = await probe('none', address.port); const egress = await probe('egress', address.port);
    for (const value of [none, egress]) { assert.notEqual(value['namespace'], await readlink('/proc/self/ns/net')); assert.equal(value['connected'], false); assert.equal(value['tun'], false); }
    assert.equal(connections, 1); assert.deepEqual(none['interfaces'], ['lo']); assert.equal(none['resolver'], '');
    assert.ok(Array.isArray(egress['interfaces']) && egress['interfaces'].includes('tap0'));
    assert.ok(typeof egress['route'] === 'string' && /tap0\s+00000000\s+0202000A/u.test(egress['route']));
    assert.equal(egress['resolver'], 'nameserver 10.0.2.3\noptions timeout:2 attempts:2\n');
  } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); }
});
