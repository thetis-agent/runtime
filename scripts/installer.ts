/** Keep the curlable installer identical to its small reviewed sources; implementation note 0052. */
import { readFile, writeFile } from 'node:fs/promises';
const sources = ['defaults', 'display', 'units', 'arguments', 'preflight', 'steps', 'verify', 'node', 'provider', 'layout', 'provision', 'cgroup', 'uninstall', 'main'];
const root = new URL('../', import.meta.url);
const unitNames = ['thetis.service', 'thetis-update.service', 'thetis-update.timer', 'state.mount'];
const cases = await Promise.all(unitNames.map(async name => `    ${name}) cat <<'UNIT'\n${await readFile(new URL(`units/${name}`, root), 'utf8')}UNIT\n      ;;\n`));
const units = `# Generated from units/ by scripts/installer.ts; edit those templates.\nunit_text() {\n  case "$1" in\n${cases.join('')}    *) die "There is no embedded unit named $1." ;;\n  esac\n}\n`;
const fragment = new URL('scripts/installer/units.sh', root);
const text = (await Promise.all(sources.map(async name => name === 'units' ? units : readFile(new URL(`scripts/installer/${name}.sh`, root), 'utf8')))).join('');
const output = new URL('install.sh', root);
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== text || await readFile(fragment, 'utf8') !== units) {
    process.stderr.write('install.sh is stale; run scripts/installer.ts.\n'); process.exitCode = 1;
  }
} else { await writeFile(fragment, units); await writeFile(output, text, { mode: 0o755 }); }
