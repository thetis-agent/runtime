/** Keep scoped session negotiation identical at both ends of the boundary; KS-004. */
import type { Method } from '@/contracts/kernel-socket/types.ts';
import type { Result } from '@/lib/schema/index.ts';
import { isObject } from '@/lib/schema/index.ts';
export const sessionMethods: readonly Method[] = ['session.list', 'session.create', 'session.submit', 'session.subscribe', 'session.cancel', 'session.rename', 'session.archive', 'session.choices', 'session.choose'];

/** The `session.list` person that means "everyone whose environment is running" rather than one name.
 * Reserved rather than invented: a person id is an account name and none is spelled this way, and a
 * role that may not observe others is refused this name exactly as it is refused any other. */
export const everyone = '*';

/** A person's environment, as the fan-out below needs to see one: a name, and a way to ask it. */
export interface Listable { owner: string; list(params: Record<string, unknown>): Promise<Result<unknown>> }

/** Everyone's conversations, asked for one environment at a time and stamped with whose each row is.
 *
 * A conversation store holds one person's conversations and nothing else, so a row carries no owner of
 * its own; the fan-out is the only place that knows, and therefore the only place that can say. Each
 * environment is asked under its own name so its own ownership check still answers the question it was
 * written to answer. A refusal from any one of them ends the survey rather than quietly omitting that
 * person, because a list missing a name reads exactly like a person with no conversations. */
export async function listEveryone(environments: readonly Listable[], params: Record<string, unknown>): Promise<Result<unknown>> {
  const rows: unknown[] = [];
  for (const environment of environments) {
    const listed = await environment.list({ ...params, person: environment.owner }); if (!listed.ok) return listed;
    for (const row of Array.isArray(listed.value) ? listed.value : []) rows.push(isObject(row) ? { ...row, owner: environment.owner } : row);
  }
  return { ok: true, value: rows };
}
