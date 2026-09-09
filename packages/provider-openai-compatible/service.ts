/** Read the shared key only from registered spawn delivery; PR-013, ADR 0019. */
import { serve } from '../../lib/provider/service.ts';
import { configure } from './startup.ts';

const result = await serve((settings, authority, budgets, schemas, clock) => configure(settings, process.env['LLM_KEY'], authority, budgets, schemas, clock), outcome => {
  if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`);
});
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
