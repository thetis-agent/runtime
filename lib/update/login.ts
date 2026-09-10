/** Exchange an administrator's password for a kernel-issued session on the login target's private socket, never through a command line; ADR 0048, KS-017. */
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const loginLimits = { bodyBytes: 65536, deadlineMs: 30000 };

/** The same formula `docs/headless-startup.md` publishes for every target's public socket. */
export function publicSocket(root: string, target: string): string {
  return join(root, 'targets', createHash('sha256').update(target).digest('base64url'), 'runs/public/current.sock');
}

function answer(socketPath: string, body: string): Promise<Result<{ status: number; text: string }>> {
  return new Promise(resolve => {
    const outgoing = request({ socketPath, method: 'POST', path: '/login', timeout: loginLimits.deadlineMs,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > loginLimits.bodyBytes) response.destroy(); else chunks.push(chunk); });
      response.once('error', () => { resolve(failure('io', 'The login surface closed before it answered.')); });
      response.once('end', () => { resolve({ ok: true, value: { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') } }); });
    });
    outgoing.once('timeout', () => { outgoing.destroy(); resolve(failure('deadline', 'The login surface exceeded its deadline.')); });
    outgoing.once('error', () => { resolve(failure('io', 'The login surface could not be reached on its socket.')); });
    outgoing.end(body);
  });
}

export async function login(socketPath: string, id: string, password: string): Promise<Result<string>> {
  const replied = await answer(socketPath, JSON.stringify({ id, password })); if (!replied.ok) return replied;
  if (replied.value.status !== 200) return failure('forbidden', 'The login surface refused that account or password.');
  let parsed: unknown;
  try { parsed = JSON.parse(replied.value.text); } catch { return failure('io', 'The login surface answered something other than JSON.'); }
  const value = isObject(parsed) ? parsed['value'] : undefined;
  const token = isObject(value) ? value['sessionToken'] : undefined;
  return typeof token === 'string' && token.length > 0 ? { ok: true, value: token } : failure('io', 'The login surface answered without a session token.');
}
