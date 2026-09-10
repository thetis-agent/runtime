/** Defend the publish gate with strict checking and zero warnings; ADR 0002. */
import { generateAll } from '@/lib/schema/generate.ts';
import { checkWorkspace, execute } from '@/scripts/workspace.ts';
import { sourceFlags } from '@/lib/artifacts/index.ts';

if (!process.argv.includes('--workspace')) {
  process.exitCode = await checkWorkspace();
} else if (!await generateAll(true)) {
  process.stderr.write('Contract types are stale; run npm run generate.\n');
  process.exitCode = 1;
} else {
  const typecheck = await execute(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict']);
  const lint = await execute(process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--max-warnings=0']);
  const artifacts = await execute(process.execPath, [...sourceFlags(), 'scripts/build.ts', '--workspace', '--check']);
  process.exitCode = Math.max(typecheck, lint, artifacts);
}
