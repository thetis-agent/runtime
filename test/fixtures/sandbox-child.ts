/** Probe actual mounts and inherited authority from inside the runner; TE-024, ADR 0005. */
import { readFile, writeFile } from 'node:fs/promises';
import { authority } from '../../lib/sandbox-runner/authority.ts';

const received = await authority();
if (!received.ok) { process.stderr.write(received.error.message); process.exitCode = 1; }
else {
  const flags = await readFile('/proc/self/fdinfo/3', 'utf8');
  const field = /^flags:\s+([0-7]+)$/mu.exec(flags)?.[1];
  const closeOnExec = field !== undefined && (Number.parseInt(field, 8) & 0o2000000) !== 0;
  await writeFile('/work/result', 'sandboxed');
  let outside = false;
  try { await writeFile('/not-granted', 'forbidden'); } catch { outside = true; }
  received.value.socket.end(JSON.stringify({ closeOnExec, outside, tokenMatches: received.value.token === 'test-run' }));
}
