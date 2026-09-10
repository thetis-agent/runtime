/** Run the password gateway behind actual inherited authority and bubblewrap; KS-006–007, ADR 0018, ADR 0038. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { loginFixture } from '@/test/login-fixture.ts';
import { Journal } from '@/kernel/log/index.ts';
import { Process } from '@/kernel/boundary/process.ts';
import type { Context } from '@/kernel/boundary/process.ts';
import type { Operation } from '@/kernel/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import { SandboxRunner } from '@/lib/sandbox-runner/index.ts';
import { packageEntry, packageMounts } from '@/test/package-mounts.ts';

export async function loginProcess() {
  const f = await loginFixture(); await mkdir(join(f.root, 'endpoint')); await mkdir(join(f.root, 'state'));
  await rename(f.path, join(f.root, 'state/accounts.json'));
  const issued = f.identity.issue({ id: 'login', person: '', scope: 'deployment', target: 'login', generation: 1, services: [] }); assert.ok(issued.ok);
  const journal = await Journal.open(join(f.root, 'rows.jsonl'), () => f.clock.now()); assert.ok(journal.ok);
  const methods = new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
    ['profile.get', () => Promise.resolve({ ok: true, value: {} })],
    ['identity.assert', (run, params) => { assert.ok(typeof params['kind'] === 'string' && typeof params['id'] === 'string'); return Promise.resolve(f.identity.session(run.target, params['kind'], params['id'])); }]
  ]);
  const context: Context = { target: 'login', identity: f.identity, schemas: f.schemas, clock: f.clock, journal: journal.value, runner: new SandboxRunner('/cgroup'), operations: { methods, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) } };
  const repository = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
  const started = await Process.start({ name: 'fixture', version: '1.0.0', entry: packageEntry(repository, 'gateway-login', 'service.ts'), args: [], cwd: '/state', mounts: [
    ...packageMounts(repository, ['gateway-login']),
    { source: join(f.root, 'state'), path: '/state', mode: 'rw', maximumBytes: 67108864 },
    { source: join(f.root, 'endpoint'), path: '/endpoint', mode: 'rw', maximumBytes: 67108864 }
  ] }, issued.value, context); assert.ok(started.ok, JSON.stringify(started));
  return { ...f, path: join(f.root, 'state/accounts.json'), token: issued.value, process: started.value, socket: join(f.root, 'endpoint/service.sock'), rows: () => readFile(join(f.root, 'rows.jsonl'), 'utf8'), async close() {
    assert.ok((await started.value.stop('test complete')).ok); await journal.value.close(); await f.close();
  } };
}

export function loginRequest(socketPath: string, input: unknown): Promise<{ status: number; headers: Record<string, unknown>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path: '/login', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: unknown) => { assert.ok(Buffer.isBuffer(chunk)); bytes += chunk.length; if (bytes > 16384) { client.destroy(new Error('The login response exceeded its test limit.')); return; } chunks.push(chunk); });
      response.once('end', () => { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve({ status: response.statusCode ?? 0, headers: response.headers, body }); });
    });
    client.once('error', reject); client.end(JSON.stringify(input));
  });
}

interface RawResponse { status: number; headers: Record<string, unknown>; body: string }

function collect(client: ReturnType<typeof request>, response: IncomingMessage, resolve: (value: RawResponse) => void): void {
  const chunks: Buffer[] = []; let bytes = 0;
  response.on('data', (chunk: unknown) => { assert.ok(Buffer.isBuffer(chunk)); bytes += chunk.length; if (bytes > 65536) { client.destroy(new Error('The login response exceeded its test limit.')); return; } chunks.push(chunk); });
  response.once('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
}

/** GET/HEAD the sign-in page or its stylesheet, without following any redirect. */
export function loginGet(socketPath: string, path: string, method: 'GET' | 'HEAD' = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const client = request({ socketPath, path, method }, response => { collect(client, response, resolve); });
    client.once('error', reject); client.end();
  });
}

/** Submit the sign-in form as a browser would, capturing the redirect and cookie rather than following them. */
export function loginFormRequest(socketPath: string, fields: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(fields).toString();
    const client = request({ socketPath, path: '/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, response => { collect(client, response, resolve); });
    client.once('error', reject); client.end(payload);
  });
}
