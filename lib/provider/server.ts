/** Authenticate outside prompt events and read cancellation beside streamed responses; PR-001–003, ADR 0019. */
import type { Socket } from 'node:net';
import { clock } from '@/lib/events/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import { Service, serviceLimits } from './lifecycle.ts';
import type { Connection } from './lifecycle.ts';
import { Queue } from '@/lib/events/queue.ts';
import { socketFrames, send } from '@/lib/ndjson/socket.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Provider } from './index.ts';
import type { ConnectRequest, DescribeRequest, RequestEvent, ResponseEvent } from '@/contracts/provider/types.ts';

type Reader = ReturnType<typeof socketFrames>;

async function read(reader: Reader, queue: Queue<RequestEvent>, controller: AbortController, schemas: Schemas, admitted: () => void): Promise<Result<void>> {
  const validate = schemas.validator<RequestEvent>('provider', 'requestEvent');
  let ended = false; let id: string | undefined;
  try {
    for await (const frame of reader) {
      if (!frame.ok) return frame;
      if (!validate(frame.value)) return failure('provider', 'The provider request frame violates its schema.');
      const event = frame.value;
      if (event.type === 'cancel') {
        if (id !== event.id) return failure('provider', 'The cancellation names another request.');
        controller.abort(); return { ok: true, value: undefined };
      }
      if (ended) return failure('provider', 'The connection already has a completed request.');
      if (event.type === 'begin') id = event.id;
      const queued = queue.push(event, Buffer.byteLength(JSON.stringify(event))); if (!queued.ok) return queued;
      if (event.type === 'end') { ended = true; queue.close(); admitted(); }
    }
    controller.abort(); return { ok: true, value: undefined };
  } catch {
    if (controller.signal.aborted) return { ok: true, value: undefined };
    controller.abort(); return failure('provider', 'The provider request socket closed.');
  }
  finally { queue.close(); }
}

async function exchange(connection: Connection, reader: Reader, provider: Provider, token: string, schemas: Schemas): Promise<Result<void>> {
  const { socket } = connection;
  const queue = new Queue<RequestEvent>(); const controller = new AbortController();
  const state: { outcome: Result<void> } = { outcome: { ok: true, value: undefined } };
  const reading = read(reader, queue, controller, schemas, connection.admitted).then(result => {
    if (!result.ok) { state.outcome = result; controller.abort(); }
    return result;
  });
  try {
    for await (const event of provider.run(queue, token, controller.signal)) {
      if (!state.outcome.ok) { await send(socket, { type: 'error', code: 'provider', message: state.outcome.error.message }); break; }
      const written = await send(socket, event);
      if (!written.ok) { state.outcome = written; controller.abort(); break; }
      if (event.type === 'error') state.outcome = failure(event.code, event.message);
    }
  } catch {
    state.outcome = failure('provider', 'The provider exchange failed.');
    await send(socket, { type: 'error', ...state.outcome.error });
  } finally { controller.abort(); socket.end(); socket.destroy(); await reading; }
  return state.outcome;
}

async function refuse(socket: Socket, code: Extract<ResponseEvent, { type: 'error' }>['code'], message: string): Promise<Result<void>> {
  await send(socket, { type: 'error', code, message }); socket.end();
  return failure(code, message);
}

async function serve(connection: Connection, provider: Provider, schemas: Schemas): Promise<Result<void>> {
  const { socket } = connection;
  const reader = socketFrames(socket);
  const first = await reader.next();
  const connect = schemas.validator<ConnectRequest>('provider', 'connectRequest');
  if (first.done || !first.value.ok || !connect(first.value.value)) return refuse(socket, 'auth', 'The inherited run credential is required.');
  const token = first.value.value.runToken;
  const next = await reader.next();
  if (next.done || !next.value.ok) return refuse(socket, 'provider', 'The request ended before its first event.');
  if (isObject(next.value.value) && next.value.value['method'] === 'describe') {
    if (!schemas.validator<DescribeRequest>('provider', 'describeRequest')(next.value.value)) return refuse(socket, 'provider', 'The describe request violates its schema.');
    const description = await provider.describe();
    const sent = await send(socket, description.ok ? { v: '1', ...description.value } : { type: 'error', ...description.error }); socket.end();
    return !description.ok ? description : sent;
  }
  async function* restored(): Reader { yield next.value; yield* reader; }
  return exchange(connection, restored(), provider, token, schemas);
}

export async function listen(path: string, provider: Provider, schemas: Schemas, observe: (outcome: Result<void>) => void, time: Clock = clock, limits = serviceLimits): Promise<Result<Service, 'provider'>> {
  const service = new Service(time, limits);
  const opened = await service.open(path, connection => serve(connection, provider, schemas), observe);
  return opened.ok ? { ok: true, value: service } : opened;
}
