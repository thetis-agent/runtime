/** Summarize diagnostic metadata without forwarding provider content or per-token frames; ADR 0014, ADR 0019. */
import { createHash } from 'node:crypto';
import type { StageRow } from '../../lib/events/stages.ts';
import type { End, CallAnswer, ToolDef } from '../../contracts/turn-events/types.ts';
import type { Entry } from '../../contracts/skills/types.ts';
import type { Result } from '../../lib/schema/index.ts';
import { failure } from '../../lib/schema/index.ts';

export const reportLimits = { bytes: 60 * 1024, rows: 4096, identifiers: 256 };
function identifier(value: string): string {
  return Buffer.byteLength(value) <= reportLimits.identifiers ? value : `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export class TurnReport {
  readonly #stages = new Map<string, StageRow & { count: number }>();
  readonly #retrieved: { iteration: number; ids: string[] }[] = [];
  readonly #offered: { iteration: number; names: string[] }[] = [];
  readonly #calls: { iteration: number; id: string; name: string; outcome: string; elapsed: number }[] = [];
  #bytes = 1024;
  #failed = false;
  #closed = false;
  get exhausted(): boolean { return this.#failed; }
  stage(row: StageRow): void {
    if (this.#closed || this.#failed) return;
    const safe = { source: identifier(row.source), event: identifier(row.event), outcome: identifier(row.outcome), elapsed: row.elapsed };
    const key = JSON.stringify([safe.source, safe.event, safe.outcome]); const previous = this.#stages.get(key);
    if (previous) { previous.count++; previous.elapsed += safe.elapsed; return; }
    const value = { ...safe, count: 1 };
    if (this.#stages.size >= reportLimits.rows || !this.#reserve(value)) { this.#failed = true; return; }
    this.#stages.set(key, value);
  }
  retrieve(iteration: number, entries: Entry[]): void {
    if (entries.length > reportLimits.rows) { this.#failed = true; return; }
    const value = { iteration, ids: entries.map(entry => identifier(entry.id)) };
    if (this.#reserve(value)) this.#retrieved.push(value);
  }
  offer(iteration: number, tools: ToolDef[]): void {
    if (tools.length > reportLimits.rows) { this.#failed = true; return; }
    const value = { iteration, names: tools.map(tool => identifier(tool.name)) };
    if (this.#reserve(value)) this.#offered.push(value);
  }
  call(iteration: number, name: string, answer: CallAnswer, elapsed: number): void {
    const value = { iteration, id: identifier(answer.id), name: identifier(name), outcome: answer.ok ? 'ok' : answer.error?.code ?? 'tool', elapsed };
    if (this.#reserve(value)) this.#calls.push(value);
  }
  finish(conversation: string, turn: number, end: End): Result<Record<string, unknown>, 'budget'> {
    this.#closed = true;
    const value = { conversation: identifier(conversation), turn, end: { reason: end.reason, iterations: end.iterations, compactions: end.compactions },
      stages: [...this.#stages.values()], retrieved: this.#retrieved, offered: this.#offered, calls: this.#calls };
    return this.#failed || Buffer.byteLength(JSON.stringify(value)) > reportLimits.bytes ? failure('budget', 'The turn report exceeds its byte limit.') : { ok: true, value };
  }
  #reserve(value: unknown): boolean {
    if (this.#closed || this.#failed) return false;
    this.#bytes += Buffer.byteLength(JSON.stringify(value)) + 32;
    this.#failed = this.#bytes > reportLimits.bytes; return !this.#failed;
  }
}
