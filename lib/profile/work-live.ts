/** Apply reviewed work only through the owning environment's generation machine; GN-001, KS-009. */
import { WorkQueue } from './work.ts';
import type { Work, Settings } from './work.ts';
import { overlay, facts, matched, capturedTarget } from './work-overlay.ts';
import type { ConfiguredTarget } from '@/lib/deployment/index.ts';
import type { Captured, Entry } from '@/lib/package-loader/types.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Provision } from '@/lib/semver-match/index.ts';
import { limits } from './index.ts';
export interface Changes {
  describe?(target: ConfiguredTarget): Promise<Result<Captured>>;
  switch(target: ConfiguredTarget): Promise<Result<void>>;
  observe(result: Result<void>, changes: readonly Work[], elapsedMs: number): void | Promise<void>;
  facts?: readonly Provision[];
}
export class LiveWork {
  readonly queue: WorkQueue;
  #current: ConfiguredTarget;
  private constructor(current: ConfiguredTarget, root: string, cache: string, time: Clock, schemas: Schemas, dependencies: readonly Provision[], callbacks: Changes, settings?: Settings) {
    this.#current = current;
    this.queue = new WorkQueue(root, cache, time, async (changes, stagedMs) => {
      const began = time.now(); const result = await this.#apply(changes, dependencies, callbacks, schemas);
      await callbacks.observe(result, changes, stagedMs + time.now() - began); return result;
    }, { ...limits, ...settings, artifacts: current.revision.plan.execution === 'artifacts', previous: name => {
      const selected: Entry[] = this.#current.entries; const entry = selected.find(entry => entry.manifest.name === name);
      return entry ? this.#current.revision.pins[`alias:/packages/${entry.manifest.name}@${entry.manifest.version}`]?.source : undefined;
    } });
  }
  static async open(current: ConfiguredTarget, root: string, cache: string, time: Clock, schemas: Schemas, callbacks: Changes, settings?: Settings): Promise<Result<LiveWork>> {
    const dependencies = await facts(current, schemas); if (!dependencies.ok) return dependencies;
    const value = new LiveWork(structuredClone(current), root, cache, time, schemas, [...dependencies.value, ...callbacks.facts ?? []], callbacks, settings);
    const watched = await value.queue.watch(); return watched.ok ? { ok: true, value } : watched;
  }
  async #apply(changes: readonly Work[], dependencies: readonly Provision[], callbacks: Changes, schemas: Schemas): Promise<Result<void>> {
    const next = await overlay(this.#current, changes, schemas); if (!next.ok) return next;
    let target = next.value;
    const requirements = await matched(target, dependencies, undefined, schemas);
    const selected: Entry[] = target.entries;
    const dynamic = selected.some(entry => changes.some(change => change.name === entry.manifest.name) && entry.manifest.envelope.provides.length > 0);
    if (!requirements.ok && requirements.error.code === 'gap' && dynamic && callbacks.describe) {
      const captured = await callbacks.describe(next.value); if (!captured.ok) return captured;
      const registered = await capturedTarget(target, captured.value, dependencies, schemas); if (!registered.ok) return registered; target = registered.value;
    } else if (!requirements.ok) return requirements;
    const switched = await callbacks.switch(target); if (switched.ok) this.#current = target;
    return switched;
  }
  close(): Promise<Result<void>> { return this.queue.close(); }
}
