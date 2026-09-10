/** Probe the real candidate mount boundary without seeing private evaluator assets; EV-002. */
import { access } from 'node:fs/promises';
import { resolvePath } from '../../lib/files/index.ts';
const results: unknown[] = [];
for (const path of ['/suite/private', '/checks/run.sh', '/seeds/private']) {
  let exists = true;
  try { await access(path); } catch { exists = false; }
  results.push({ path, exists, result: await resolvePath(path, [{ path: '/space', mode: 'rw', space: 'person' }]) });
}
process.stdout.write(JSON.stringify(results));
