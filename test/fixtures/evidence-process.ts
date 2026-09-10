/** Supply an external evaluator and login edge over real inherited authority; KS-014, KS-015. */
import { writeFile } from 'node:fs/promises';
import { serve } from '../../lib/service/index.ts';
import { socketFrames, send } from '../../lib/ndjson/socket.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
const result = await serve(async (settings, _schemas, peer) => {
  if (isObject(settings) && settings['holdServing'] === true) {
    let writable = false;
    try { await writeFile('/work/promoting', 'ready'); writable = true; }
    catch (error) { if (!isObject(error) || error['code'] !== 'EROFS') return failure('io', 'The test serving barrier could not be written.'); }
    if (writable) await new Promise(() => {});
  }
  return { ok: true, value: async connection => {
  for await (const frame of socketFrames(connection.socket)) {
    if (!frame.ok) return frame;
    if (!isObject(frame.value) || !isObject(frame.value['params'])) return failure('invalid-args', 'The test authority request is invalid.');
    const method = frame.value['method']; if (method !== 'results.submit' && method !== 'identity.assert') return failure('unsupported', 'The test authority supports only evidence and authentication.');
    connection.admitted(); const result = await peer.call(method, frame.value['params']); return send(connection.socket, result);
  }
  return failure('invalid-args', 'The test authority request is absent.');
} }; }, () => {}, ['results.submit', 'identity.assert']);
if (!result.ok) process.exitCode = 1;
