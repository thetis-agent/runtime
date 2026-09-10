/** Pin the ADR 0021 counterexample with a real socket in the test sandbox; TE-024. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { sourceFlags } from '@/lib/artifacts/index.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function forward(socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...sourceFlags(), new URL('./fixtures/descriptor-parent.ts', import.meta.url).pathname], {
      env: {}, stdio: ['ignore', 'inherit', 'inherit', socket]
    });
    child.once('error', reject);
    child.once('exit', code => { resolve(code ?? 1); });
  });
}

await test('ADR-0021 real inherited socket can be explicitly forwarded by an unprivileged stage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thetis-descriptor-'));
  const server = createServer();
  const path = join(directory, 'kernel.sock');
  const received = new Promise<string>((resolve, reject) => {
    server.once('connection', socket => {
      socket.once('error', reject);
      socket.once('data', data => { resolve(data.toString()); socket.end(); });
    });
    server.once('error', reject);
  });
  try {
    await new Promise<void>(resolve => { server.listen(path, resolve); });
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
    });
    try {
      assert.equal(await forward(socket), 0);
      assert.equal(await received, 'child-used-the-inherited-socket');
    } finally { socket.destroy(); }
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(directory, { recursive: true });
  }
});

await test('TE-024 ordinary children inherit neither kernel descriptors nor credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thetis-ordinary-'));
  const server = createServer(socket => { socket.on('end', () => { socket.end(); }); });
  const path = join(directory, 'kernel.sock');
  await new Promise<void>(resolve => { server.listen(path, resolve); });
  const socket = createConnection(path);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
    });
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [...sourceFlags(), new URL('./fixtures/ordinary-parent.ts', import.meta.url).pathname], {
        env: {}, stdio: ['ignore', 'pipe', 'inherit', socket]
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 4096) { child.kill(); reject(new Error('Child diagnostic limit exceeded.')); }
      });
      child.once('error', reject);
      child.once('exit', code => { resolve({ code: code ?? 1, output }); });
    });
    assert.deepEqual(result, { code: 0, output: 'ordinary-child-has-no-authority' });
  } finally {
    socket.end();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    await rm(directory, { recursive: true });
  }
});
