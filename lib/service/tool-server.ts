/** Carry tool payloads outside the kernel and cancel local work on disconnect; TS-001–004. */
import type { CallRequest, CallAnswer } from '@/contracts/turn-events/types.ts';
import type { Request } from '@/contracts/tool-service/types.ts';
import type { Connection } from './lifecycle.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import { send, socketFrames } from '@/lib/ndjson/socket.ts';
import { toolSchemas, toolError } from './tool-client.ts';
import { encode } from '@/lib/ndjson/index.ts';

export type ToolHandler = (request: CallRequest, token: string, signal: AbortSignal) => Promise<CallAnswer>;

export async function toolServer(schemas: Schemas, handler: ToolHandler): Promise<(connection: Connection) => Promise<Result<void>>> {
  const schema = await toolSchemas(schemas); const validate = schemas.definition<Request>(schema, 'request');
  return async connection => {
    const { socket } = connection; const controller = new AbortController();
    const cancel = (): void => { controller.abort(); };
    socket.once('close', cancel); socket.once('end', cancel);
    try {
      const reader = socketFrames(socket); const first = await reader.next();
      if (first.done || !first.value.ok || !validate(first.value.value)) return failure('invalid-args', 'The tool service request violates its contract.');
      const request = first.value.value; connection.admitted();
      // Only one request is permitted. Read beside the handler to observe disconnects and extra frames.
      const disconnected = reader.next().then(() => { cancel(); }, cancel);
      let answer = await handler(request.call, request.runToken, controller.signal);
      if (!schemas.validator<CallAnswer>('turn-events', 'callAnswer')(answer) || answer.id !== request.call.id) answer = toolError(request.call.id, 'tool', 'The tool service returned an invalid answer.');
      if (!encode(answer).ok) answer = toolError(request.call.id, 'budget', 'The tool service result exceeds its frame limit.');
      const written = await send(socket, answer); socket.destroy(); await disconnected;
      return written.ok ? { ok: true, value: undefined } : failure('io', 'The tool service reply could not be sent.');
    } finally { cancel(); socket.removeListener('close', cancel); socket.removeListener('end', cancel); }
  };
}
