/** Detect implicit socket inheritance without assuming descriptor 3 is unused; TE-024. */
import { readdir, readlink } from 'node:fs/promises';
import assert from 'node:assert/strict';

for (const descriptor of await readdir('/proc/self/fd')) {
  if (Number(descriptor) <= 2) continue;
  let target: string;
  try { target = await readlink(`/proc/self/fd/${descriptor}`); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
  assert.ok(!target.startsWith('socket:'), `Unexpected inherited socket on ${descriptor}`);
}
assert.deepEqual(Object.keys(process.env), ['PATH']);
process.stdout.write('ordinary-child-has-no-authority');
