/** Apply bounded multi-target effects only through their supplied generation machines; GN-002, GN-005. */
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
export interface Member {
  id: string; freeze(): Promise<Result<void>>; capture(): Promise<Result<unknown>>;
  stage(): Promise<Result<void>>; commit(): Promise<Result<void>>; rollback(reason: string): Promise<Result<void>>;
}
export interface Phases {
  begin(): Promise<Result<void>>;
  frozen(snapshots: Record<string, unknown>): Promise<Result<void>>;
  staged(): Promise<Result<void>>; committed(): Promise<Result<void>>;
  failed(reason: string, restored: boolean): Promise<Result<void>>;
}
export async function transaction(members: readonly Member[], phases: Phases): Promise<Result<void>> {
  if (members.length > 64) return failure('budget', 'The default transaction exceeds its target limit.');
  const begun = await phases.begin(); if (!begun.ok) return begun;
  const touched: Member[] = []; const snapshots: Record<string, unknown> = {};
  const abort = async (result: { ok: false; error: { code: string; message: string } }): Promise<Result<void>> => {
    let restored = true;
    for (const member of touched) { const reset = await member.rollback(result.error.message); restored &&= reset.ok; }
    const recorded = await phases.failed(result.error.message, restored); return recorded.ok ? result : recorded;
  };
  for (const member of [...members].reverse()) { touched.push(member); const frozen = await member.freeze(); if (!frozen.ok) return abort(frozen); }
  for (const member of members) { const captured = await member.capture(); if (!captured.ok) return abort(captured); snapshots[member.id] = captured.value; }
  const frozen = await phases.frozen(snapshots); if (!frozen.ok) return abort(frozen);
  for (const member of members) { const staged = await member.stage(); if (!staged.ok) return abort(staged); }
  const staged = await phases.staged(); if (!staged.ok) return abort(staged);
  for (const member of members) { const committed = await member.commit(); if (!committed.ok) return abort(committed); }
  const committed = await phases.committed(); return committed.ok ? committed : abort(committed);
}
