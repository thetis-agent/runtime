/** Admit only trusted supervisor controls for a code-verified kernel maintenance generation; ADR 0012 §6, GN-007. */
import { host } from '@/lib/maintenance/host.ts';
import { start } from '@/kernel/main.ts';
const result = await host(start, ['1']);
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
