/** Bound one-shot state migrations inside the same mandatory runner; GN-002, GN-006. */
import type { SandboxRunner, Plan, Exit } from './index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export async function command(runner: SandboxRunner, plan: Omit<Plan, 'socket'>, clock: Clock, deadlineMs = 10000): Promise<Result<Exit>> {
  const pair = await socketPair(); if (!pair.ok) return pair;
  const started = await runner.start({ ...plan, socket: pair.value.client });
  if (!started.ok) { const closed = await pair.value.close(); return closed.ok ? started : closed; }
  const timer = new AbortController();
  const deadline = clock.wait(deadlineMs, timer.signal).then(() => undefined);
  let result: Result<Exit>;
  try {
    const exit = await Promise.race([started.value.exited, deadline]);
    const cleaned = exit ? await started.value.dispose() : await started.value.stop();
    result = !cleaned.ok ? cleaned : exit ? { ok: true, value: exit } : failure('deadline', 'The state migration exceeded its deadline.');
  } finally { timer.abort(); await deadline; }
  const closed = await pair.value.close(); return closed.ok ? result : closed;
}
