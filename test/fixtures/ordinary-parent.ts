/** Exercise the standard child path from a process that owns a kernel descriptor; TE-024. */
import { spawnChild } from '../../lib/sandbox-runner/children.ts';

const child = spawnChild(process.execPath, [new URL('./ordinary-child.ts', import.meta.url).pathname]);
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
