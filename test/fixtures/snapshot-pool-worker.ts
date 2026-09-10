/** Crash an actual worker edge to verify pool recovery without replaying failed jobs; GN-002. */
import { parentPort } from 'node:worker_threads';
import { isObject } from '../../lib/result/index.ts';
if (!parentPort) throw new Error('The worker fixture requires a parent port.');
const port = parentPort;
port.on('message', (message: unknown) => {
  if (isObject(message) && message['path'] === 'crash') throw new Error('Requested worker edge failure.');
  if (isObject(message) && message['path'] === 'exit') { process.exitCode = 1; port.close(); return; }
  port.postMessage({ ok: true, value: 'fixture' });
});
