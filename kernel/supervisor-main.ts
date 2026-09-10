/** Run the trusted kernel as a supervised generation so no later start is a restart outside the machine; ADR 0048, ADR 0012 §6, GN-007. */
import { supervise } from '@/lib/maintenance/supervisor.ts';
import { Generations } from '@/kernel/generations/index.ts';
import { Journal } from '@/kernel/log/index.ts';
const result = await supervise(process.argv.slice(2), { machine: Generations, journal: Journal });
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
