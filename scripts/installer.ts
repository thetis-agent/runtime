/** Keep the curlable installer identical to its small reviewed sources; ADR 0052. */
import { readFile, writeFile } from 'node:fs/promises';
const sources = ['defaults', 'units', 'arguments', 'preflight', 'steps', 'verify', 'node', 'layout', 'provision', 'cgroup', 'uninstall', 'main'];
const root = new URL('../', import.meta.url);
const text = (await Promise.all(sources.map(name => readFile(new URL(`scripts/installer/${name}.sh`, root), 'utf8')))).join('');
const output = new URL('install.sh', root);
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== text) {
    process.stderr.write('install.sh is stale; run scripts/installer.ts.\n'); process.exitCode = 1;
  }
} else await writeFile(output, text, { mode: 0o755 });
