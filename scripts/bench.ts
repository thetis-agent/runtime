/** Enforce the approved memory and edit-latency ceilings in the mandatory sandbox; ADR 0041, ADR 0042. */
import { execute } from './workspace.ts';
process.exitCode = await execute(process.execPath, ['scripts/test.ts', 'test/acceptance-performance.test.ts', 'test/deployment-assembly.test.ts']);
