/** Restrict actors to one hook and retain owner identity outside payloads; ADR 0015 §6. */
import type { Envelope, Context, Message, OfferRequest, CallRequest, Notice } from '@/contracts/turn-events/types.ts';
import type { RetrieveRequest } from '@/contracts/skills/types.ts';
import type { SpillSink } from '@/lib/spill/index.ts';

export interface Stage {
  source: string;
  gateway?: boolean;
  section?: 'harness' | 'history';
  observe?: (event: Envelope) => unknown;
  context?: (append: (message: Message) => void, context: Context) => unknown;
  offer?: (request: OfferRequest) => Promise<unknown>;
  call?: (request: CallRequest, sink: SpillSink, signal?: AbortSignal) => Promise<unknown>;
  retrieve?: (request: RetrieveRequest) => Promise<unknown>;
  init?: (emit: (notice: Omit<Notice, 'source'>) => void) => Promise<void>;
  shutdown?: () => Promise<void>;
}
export interface StageRow { source: string; event: string; outcome: string; elapsed: number }

export function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  function freeze(item: unknown): void {
    if (typeof item !== 'object' || item === null || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}
