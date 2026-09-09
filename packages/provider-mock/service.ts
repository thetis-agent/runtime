/** Expose the scripted provider only with inherited authority and durable budgets; PR-010–014. */
import { serve } from '../../lib/provider/service.ts';
import { MockProvider } from './index.ts';

const result = await serve((_settings, authority, budgets) => ({ ok: true, value: new MockProvider([], authority, budgets) }), outcome => {
  if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`);
});
if (!result.ok) { process.stderr.write(`${JSON.stringify(result)}\n`); process.exitCode = 1; }
