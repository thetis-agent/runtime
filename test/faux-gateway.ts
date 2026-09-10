/** Exercise the gateway boundary using identity evidence only; KS-006, EV-006. */
import type { Envelope } from '@/contracts/turn-events/types.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';

export interface Sessions {
  submit(conversation: string, input: { text: string; attachments: never[] }): Promise<Result<void>>;
  cancel(conversation: string): Promise<Result<void>>;
}

export class FauxGateway {
  readonly events: Envelope[] = [];
  readonly #sessions: Sessions;
  readonly #limit: number;
  constructor(sessions: Sessions, eventLimit = 4096) { this.#sessions = sessions; this.#limit = eventLimit; }
  input(conversation: string, text: string): Promise<Result<void>> {
    return this.#sessions.submit(conversation, { text, attachments: [] });
  }
  cancel(conversation: string): Promise<Result<void>> { return this.#sessions.cancel(conversation); }
  observe(event: Envelope): Result<void, 'budget'> {
    if (this.events.length >= this.#limit) return failure('budget', 'The faux gateway event queue is full.');
    this.events.push(structuredClone(event));
    return { ok: true, value: undefined };
  }
}
