/** A transcript never turns a bounded stream into an unbounded socket reply; KS-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@/contracts/turn-events/types.ts';
import { historyTail, historyLimits } from './history.ts';

function message(text: string): Message { return { role: 'user', source: 'core', content: [{ type: 'text', text }] }; }

await test('Saved transcript tails preserve order and report message-count truncation', () => {
  assert.deepEqual(historyTail([]), { messages: [], truncated: false });
  const messages = [message('first'), message('second')];
  assert.deepEqual(historyTail(messages), { messages, truncated: false });
  const many = Array.from({ length: historyLimits.messages + 1 }, (_, index) => message(String(index)));
  assert.deepEqual(historyTail(many), { messages: many.slice(1), truncated: true });
  assert.equal(many.length, historyLimits.messages + 1);
});

await test('Saved transcript tails are bounded by UTF-8 bytes and do not silently clip messages', () => {
  const large = message('🌊'.repeat(40000));
  assert.deepEqual(historyTail([large, large]), { messages: [large], truncated: true });
  assert.deepEqual(historyTail([message('x'.repeat(historyLimits.bytes))]), { messages: [], truncated: true });
});
