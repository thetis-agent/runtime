/** Run the private outcome check without delegated descriptors or network; ADR 0004 §1, ADR 0021. */
import { spawn } from 'node:child_process';
const check = process.argv[2];
if (!check?.startsWith('/checks/')) throw new Error('The scorer check path is missing.');
const child = spawn('/bin/sh', [check], { cwd: '/space', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
