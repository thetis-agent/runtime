/** Separate trusted observations from submitted claims in a bounded append-only journal; ADR 0014, KS-020. */
import { storage } from '@/lib/storage/index.ts';
import type { AppendLog } from '@/contracts/storage/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export type Provenance = 'kernel-observed' | 'candidate-reported' | 'reviewed-reported';
export interface Observed { provenance: 'kernel-observed'; at: number; target: string; kind: string; data: Readonly<Record<string, unknown>> }
export const limits = { bytes: 64 * 1024 * 1024, recoveryBytes: 1024 * 1024, rowBytes: 65536, queuedRows: 256 };
export class Journal {
  readonly #file: AppendLog; readonly #now: () => number; readonly #limits: typeof limits;
  private constructor(file: AppendLog, now: () => number, settings: typeof limits) { this.#file = file; this.#now = now; this.#limits = settings; }
  static async open(path: string, now: () => number, settings = limits): Promise<Result<Journal, 'io'>> {
    const opened = await storage.journal(path, settings); return opened.ok ? { ok: true, value: new Journal(opened.value, now, settings) } : opened;
  }

  observed(target: string, kind: string, data: Readonly<Record<string, unknown>>, recovery = false): Promise<Result<void, 'io' | 'budget'>> {
    return this.#append('kernel-observed', target, kind, data, recovery);
  }

  reported(target: string, kind: string, data: Readonly<Record<string, unknown>>, reviewed = false): Promise<Result<void, 'io' | 'budget'>> {
    return this.#append(reviewed ? 'reviewed-reported' : 'candidate-reported', target, kind, data, false);
  }

  #append(provenance: Provenance, target: string, kind: string, data: Readonly<Record<string, unknown>>, recovery: boolean): Promise<Result<void, 'io' | 'budget'>> {
    const bytes = Buffer.from(`${JSON.stringify({ provenance, at: this.#now(), target, kind, data })}\n`);
    return this.#file.append(bytes, this.#limits.bytes - (recovery ? 0 : this.#limits.recoveryBytes));
  }
  close(): Promise<void> { return this.#file.close(); }
}
