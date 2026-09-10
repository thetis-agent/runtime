/** Keep opt-in paid acceptance separate from offline tests and pipe the key into the trusted supervisor; PR-010, PR-013. */
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { delegate } from '../lib/sandbox-runner/cgroup.ts';
import { namespace, seal } from '../lib/sandbox-runner/namespace.ts';
import { sourceMounts } from './workspace.ts';
const limits = { keyBytes: 16384, memoryMiB: 1536, tasks: 128, temporaryBytes: 67108864 };

async function key(path: string): Promise<Buffer> {
  const child = spawn('/usr/bin/python3', ['-c', 'import sys,tomllib; value=tomllib.load(open(sys.argv[1],"rb"))["llm"]["api_key"]; sys.stdout.buffer.write(value.encode())', path], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<boolean>(resolve => { child.once('error', () => { resolve(false); }); child.once('exit', code => { resolve(code === 0); }); });
  let length = 0; const chunks: Buffer[] = [];
  for await (const value of child.stdout) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk) || (length += chunk.length) > limits.keyBytes) { child.kill('SIGKILL'); throw new Error('The key source exceeds its descriptor limit.'); }
    chunks.push(chunk);
  }
  if (!await exited || !length) throw new Error('The configured key could not be read.');
  const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0); return result;
}

async function run(path: string): Promise<number> {
  const control = await delegate(); if (!control.ok) throw new Error(control.error.message);
  const value = await key(path);
  try {
    const args = [...namespace(dirname(dirname(process.execPath)), limits.temporaryBytes).filter(argument => argument !== '--unshare-net'),
      '--dev-bind', '/dev/net/tun', '/dev/net/tun', '--dir', '/etc', '--dir', '/run', '--ro-bind', await realpath('/etc/resolv.conf'), '/etc/resolv.conf', ...await sourceMounts(fileURLToPath(new URL('..', import.meta.url))),
      '--bind', control.value, '/cgroup', '--chdir', '/workspace', ...seal,
      '--', '/runtime/bin/node', '/workspace/test/live-openrouter.ts', String(value.length)];
    const child = spawn('/usr/bin/bwrap', args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    const pipe = child.stdio[3]; if (!(pipe instanceof Writable)) throw new Error('The live key descriptor is absent.');
    pipe.once('error', () => { child.kill('SIGKILL'); }); pipe.end(value);
    return await new Promise<number>(resolve => { child.once('error', () => { resolve(1); }); child.once('exit', code => { resolve(code ?? 1); }); });
  } finally { value.fill(0); }
}

const path = process.argv[2];
if (!path) throw new Error('Provide the operator TOML key source; never pass the key itself.');
if (process.argv.includes('--delegated')) process.exitCode = await run(path);
else {
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '-p', 'Delegate=yes', '-p', `MemoryMax=${String(limits.memoryMiB)}M`, '-p', `TasksMax=${String(limits.tasks)}`, '-p', 'CPUQuota=100%', process.execPath, fileURLToPath(import.meta.url), path, '--delegated'], { stdio: 'inherit' });
  child.once('error', () => { process.exitCode = 1; }); child.once('exit', code => { process.exitCode = code ?? 1; });
}
