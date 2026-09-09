/** Defend the publish gate with strict checking and zero warnings; ADR 0002. */
import { spawn } from 'node:child_process';
import { generateAll } from '../lib/schema/generate.ts';

async function run(path: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => { resolve(code ?? 1); });
  });
}

if (!await generateAll(true)) {
  process.stderr.write('Contract types are stale; run npm run generate.\n');
  process.exitCode = 1;
} else {
  const typecheck = await run('node_modules/typescript/bin/tsc', ['--noEmit', '--strict']);
  const lint = await run('node_modules/eslint/bin/eslint.js', ['.', '--max-warnings=0']);
  process.exitCode = Math.max(typecheck, lint);
}
