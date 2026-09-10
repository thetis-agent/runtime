/** Send a bounded tail of durable messages only over the private person-scoped socket; KS-004. */
import type { Message } from '@/contracts/turn-events/types.ts';
import type { History } from './types.ts';

export const historyLimits = { messages: 256, bytes: 262144 };

export function historyTail(messages: readonly Message[]): History {
  const tail: Message[] = []; let bytes = 2;
  for (const message of [...messages].reverse()) {
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (tail.length >= historyLimits.messages || bytes + size > historyLimits.bytes) break;
    bytes += size; tail.push(message);
  }
  return { messages: tail.reverse(), truncated: tail.length !== messages.length };
}
