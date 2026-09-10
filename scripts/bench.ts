/** Enforce the approved memory and edit-latency ceilings in the mandatory sandbox; implementation note 0041, implementation note 0042. */
import { execute } from '@/scripts/workspace.ts';
import { sourceFlags } from '@/lib/artifacts/index.ts';
process.exitCode = await execute(process.execPath, [...sourceFlags(), 'scripts/test.ts', 'test/acceptance-performance.test.ts', 'test/deployment-assembly.test.ts']);
