/** Exercise a stage's permitted spawn API with its inherited descriptor; TE-024. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const descriptor = await readFile('/proc/self/fdinfo/3', 'utf8');
const flags = /^flags:\s+([0-7]+)$/mu.exec(descriptor)?.[1];
assert.ok(flags, 'The inherited descriptor must expose its Linux flags.');
assert.equal(Number.parseInt(flags, 8) & 0o2000000, 0o2000000, 'The descriptor must have close-on-exec set.');

const child = spawn(process.execPath, [new URL('./descriptor-child.ts', import.meta.url).pathname], {
  env: {}, stdio: ['ignore', 'inherit', 'inherit', 3]
});
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
