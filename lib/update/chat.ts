/** A host operator uses the existing person-scoped CLI socket; no new network surface or authority. */
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Batch } from '@/lib/session/types.ts';
import type { Install } from './install.ts';
import { publicSocket } from './login.ts';
import { join } from 'node:path';
import schema from '@/lib/session/schema.json' with { type: 'json' };

const limits = { messageBytes: 65536, outputBytes: 1048576, deadlineMs: 600000 };
type Output = (text: string) => Promise<void>;

async function request(path: string, args: string[], schemas: Schemas, output: Output): Promise<Result<unknown>> {
  const batch = schemas.compile<Batch>({ ...schema });
  const connected = await connect(path); if (!connected.ok) return connected;
  const socket = connected.value; const timer = setTimeout(() => { socket.destroy(); }, limits.deadlineMs);
  let bytes = 0;
  try {
    const written = await send(socket, { args }); if (!written.ok) return written;
    for await (const frame of socketFrames(socket)) {
      if (!frame.ok) return frame;
      const value = frame.value;
      if (!isObject(value) || typeof value.ok !== 'boolean') return failure('io', 'The CLI returned an invalid result.');
      if (!value.ok) return failure('io', isObject(value.error) && typeof value.error.message === 'string' ? value.error.message : 'The conversation failed.');
      if (!isObject(value.value) || value.value.type !== 'session.events') return { ok: true, value: value.value };
      if (!batch(value.value)) return failure('io', 'The CLI returned invalid conversation events.');
      for (const event of value.value.events) {
        if (event.type !== 'token' || typeof event.payload.text !== 'string') continue;
        const text = event.payload.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
        bytes += Buffer.byteLength(text);
        if (bytes > limits.outputBytes) return failure('budget', 'The conversation exceeded its output limit.');
        await output(text);
      }
    }
    return failure('io', 'The CLI closed before completing the conversation.');
  } catch { return failure('io', 'The conversation connection closed or exceeded its deadline.'); }
  finally { clearTimeout(timer); socket.destroy(); }
}

export async function chat(install: Install, message: string, conversation: string | undefined, schemas: Schemas, output: Output): Promise<Result<string>> {
  if (!message.trim() || Buffer.byteLength(message) > limits.messageBytes) return failure('invalid-args', 'Use chat --message with between 1 and 65536 bytes of text.');
  const path = publicSocket(join(install.state, 'live'), `${install.operator}-cli`);
  if (!conversation) {
    const created = await request(path, ['new'], schemas, output); if (!created.ok) return created;
    if (!isObject(created.value) || typeof created.value.id !== 'string') return failure('io', 'The CLI did not return a conversation id.');
    conversation = created.value.id;
  }
  const answered = await request(path, ['send', conversation, message], schemas, output); if (!answered.ok) return answered;
  return { ok: true, value: `\n\nConversation: ${conversation}\nContinue with chat --conversation ${conversation} --message "..."` };
}
