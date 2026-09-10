/** Supply a secret master key over an inherited pipe to the actual trusted entry point; KS-001, KS-015. */
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { isObject } from '@/lib/schema/index.ts';
import { flags } from '@/lib/artifacts/index.ts';
import { limits } from '@/lib/sandbox-runner/index.ts';
export async function kernelProcess(path: string, trusted = true, masterKey = Buffer.alloc(32, 7)) {
  const child = spawn(process.execPath, [`--max-old-space-size=${String(limits.heapMiB)}`, `--max-semi-space-size=${String(limits.youngMiB)}`, ...flags(), new URL('../kernel/main.ts', import.meta.url).pathname, path], { stdio: ['ignore', 'pipe', 'pipe', trusted ? 'pipe' : 'ignore'] });
  if (trusted) { const pipe = child.stdio[3]; assert.ok(pipe instanceof Writable); pipe.end(masterKey); }
  const ready = Promise.withResolvers<boolean>(); const exited = Promise.withResolvers<number | null>(); let output = ''; let errors = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8'); assert.ok(output.length <= 65536);
    if (output.includes('\n')) { const value: unknown = JSON.parse(output.trim()); ready.resolve(isObject(value) && value['ok'] === true); }
  });
  child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); assert.ok(errors.length <= 65536); });
  child.once('error', () => { ready.resolve(false); }); child.once('exit', code => { exited.resolve(code); ready.resolve(false); });
  assert.ok(await ready.promise, errors);
  assert.ok(child.pid);
  return { pid: child.pid, errors: () => errors, async crash() { child.kill('SIGKILL'); assert.equal(await exited.promise, null); }, async close() { child.kill('SIGTERM'); assert.equal(await exited.promise, 0, errors); } };
}
