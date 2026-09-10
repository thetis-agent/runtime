/** Guard the load-time refusals and the request-time contract of the asset table; ADR 0005, ADR 0037. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas, isObject } from '../schema/index.ts';
import { load, respond, limits } from './index.ts';
import type { Table } from './index.ts';

function errorCode(body: Buffer): unknown {
  const value: unknown = JSON.parse(body.toString('utf8'));
  return isObject(value) && isObject(value['error']) ? value['error']['code'] : undefined;
}

function manifest(root: string, entries: readonly { path: string; file: string; type: string }[]): Promise<string> {
  const path = join(root, 'assets.json');
  return writeFile(path, JSON.stringify({ assets: entries })).then(() => path);
}

async function schemas(): Promise<Schemas> {
  const instance = new Schemas(); await instance.load(); return instance;
}

interface Response { status: number; headers: IncomingHttpHeaders; body: Buffer }
function fetch(socket: string, method: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, method, path, headers }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once('error', reject);
      incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }); });
    });
    outgoing.once('error', reject); outgoing.end();
  });
}

async function serving(table: Table) {
  const root = await mkdtemp('/tmp/assets-http-');
  const socket = join(root, 'service.sock');
  const server = createServer((incoming, outgoing) => { void respond(table, incoming, outgoing); });
  server.listen(socket); await once(server, 'listening');
  return { socket, async close() { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); await rm(root, { recursive: true, force: true }); } };
}

await test('a symlink that leaves root is refused at load', async () => {
  const root = await mkdtemp('/tmp/assets-root-'); const outside = await mkdtemp('/tmp/assets-outside-');
  try {
    const secret = join(outside, 'secret.txt'); await writeFile(secret, 'top secret');
    await symlink(secret, join(root, 'evil'));
    const manifestPath = await manifest(root, [{ path: '/evil', file: 'evil', type: 'text/plain' }]);
    const result = await load(root, manifestPath, await schemas());
    assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error.code, 'outside-roots');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

await test('a file over the byte budget is refused at load', async () => {
  const root = await mkdtemp('/tmp/assets-root-');
  try {
    await writeFile(join(root, 'big.bin'), Buffer.alloc(limits.fileBytes + 1));
    const manifestPath = await manifest(root, [{ path: '/big.bin', file: 'big.bin', type: 'application/octet-stream' }]);
    const result = await load(root, manifestPath, await schemas());
    assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('more rows than the table budget are refused at load', async () => {
  const root = await mkdtemp('/tmp/assets-root-');
  try {
    await writeFile(join(root, 'shared.txt'), 'shared');
    const entries = Array.from({ length: limits.files + 1 }, (_, index) => ({ path: `/a${String(index)}`, file: 'shared.txt', type: 'text/plain' }));
    const manifestPath = await manifest(root, entries);
    const result = await load(root, manifestPath, await schemas());
    assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error.code, 'budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('a duplicate path is refused at load', async () => {
  const root = await mkdtemp('/tmp/assets-root-');
  try {
    await writeFile(join(root, 'a.txt'), 'a'); await writeFile(join(root, 'b.txt'), 'b');
    const manifestPath = await manifest(root, [{ path: '/dup', file: 'a.txt', type: 'text/plain' }, { path: '/dup', file: 'b.txt', type: 'text/plain' }]);
    const result = await load(root, manifestPath, await schemas());
    assert.equal(result.ok, false); assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('respond serves the table over a real Unix socket with the promised headers and statuses', async () => {
  const root = await mkdtemp('/tmp/assets-root-');
  try {
    const html = '<!doctype html><title>shell</title>';
    await writeFile(join(root, 'index.html'), html);
    await writeFile(join(root, 'app.js'), 'export const hi = 1;\n');
    const manifestPath = await manifest(root, [
      { path: '/', file: 'index.html', type: 'text/html' },
      { path: '/app.js', file: 'app.js', type: 'text/javascript' },
    ]);
    const loaded = await load(root, manifestPath, await schemas()); assert.ok(loaded.ok);
    const service = await serving(loaded.value);
    try {
      const missing = await fetch(service.socket, 'GET', '/nope');
      assert.equal(missing.status, 404); assert.equal(errorCode(missing.body), 'not-found');

      const head = await fetch(service.socket, 'HEAD', '/');
      assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-type'], 'text/html'); assert.equal(head.headers['cache-control'], 'no-store');
      const etag = head.headers.etag; assert.ok(etag);

      const shell = await fetch(service.socket, 'GET', '/');
      assert.equal(shell.status, 200); assert.equal(shell.headers.etag, etag);
      assert.deepEqual(shell.body, await readFile(join(root, 'index.html')));
      assert.equal(shell.headers['content-security-policy'], "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");

      const script = await fetch(service.socket, 'GET', '/app.js');
      assert.equal(script.headers['cache-control'], 'no-cache');
      assert.deepEqual(script.body, await readFile(join(root, 'app.js')));

      const revalidated = await fetch(service.socket, 'GET', '/', { 'if-none-match': etag });
      assert.equal(revalidated.status, 304); assert.equal(revalidated.body.length, 0);

      const wrongMethod = await fetch(service.socket, 'POST', '/');
      assert.equal(wrongMethod.status, 405); assert.equal(errorCode(wrongMethod.body), 'not-offered');

      const ranged = await fetch(service.socket, 'GET', '/app.js', { range: 'bytes=0-3' });
      assert.equal(ranged.status, 416); assert.equal(ranged.headers['accept-ranges'], 'none');
    } finally { await service.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
