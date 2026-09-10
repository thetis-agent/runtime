/** Defend the publish gate with strict checking and zero warnings; ADR 0002. */
import { generateAll } from '@/lib/schema/generate.ts';
import { checkWorkspace, execute } from '@/scripts/workspace.ts';
import { sourceFlags } from '@/lib/artifacts/index.ts';

/** The installer is the one shell deliverable, so it is parsed by the shell that runs it and linted when the linter exists; ADR 0048. */
async function shell(): Promise<number> {
  const scripts = ['install.sh', '.github/scripts/verify.sh', '.github/scripts/kernel-boundary.sh', '.github/scripts/prepare-runner.sh', '.github/scripts/install-smoke.sh'];
  const parsed = await execute('/bin/sh', ['-n', 'install.sh']);
  const generated = await execute(process.execPath, [...sourceFlags(), 'scripts/installer.ts', '--check']);
  const available = await execute('/bin/sh', ['-c', 'command -v shellcheck >/dev/null 2>&1']);
  if (available !== 0) { process.stdout.write('shellcheck is absent; install.sh was parsed but not linted.\n'); return Math.max(parsed, generated); }
  return Math.max(parsed, generated, await execute('shellcheck', ['--severity=warning', ...scripts]));
}

if (!process.argv.includes('--workspace')) {
  process.exitCode = await checkWorkspace();
} else if (!await generateAll(true)) {
  process.stderr.write('Contract types are stale; run npm run generate.\n');
  process.exitCode = 1;
} else {
  const typecheck = await execute(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict']);
  const lint = await execute(process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--max-warnings=0']);
  const artifacts = await execute(process.execPath, [...sourceFlags(), 'scripts/build.ts', '--workspace', '--check']);
  process.exitCode = Math.max(typecheck, lint, artifacts, await shell());
}
