/** Evaluate packages away from the responsive environment monitor; ADR 0027, TE-022. */
import { parentPort, workerData } from 'node:worker_threads';
import { Schemas } from '../../lib/schema/index.ts';
import { limits, validator } from '../../lib/package-loader/index.ts';
import { load } from '../../lib/package-loader/load.ts';
import type { Setup, WorkerCommand, WorkerMessage } from '../../lib/package-loader/types.ts';
import type { Stage } from '../../lib/events/stages.ts';
import { control } from './control.ts';
import type { Peer } from '../../lib/socket/index.ts';

const port = parentPort;
if (!port) throw new Error('The environment loop requires its monitor port.');
const schemas = new Schemas(); await schemas.load();
const check = await validator<Setup>(schemas, 'setup'); const command = await validator<WorkerCommand>(schemas, 'workerCommand');
const setup: unknown = workerData;
const stages: Stage[] = [];
let endpoint: Peer | undefined;
let outgoing = 0;
function send(message: WorkerMessage): void {
  if (++outgoing > limits.messages || Buffer.byteLength(JSON.stringify(message)) > limits.messageBytes) throw new Error('The initialization message budget is full.');
  port?.postMessage(message);
}

async function initialize(value: Setup): Promise<void> {
  for (const entry of value.entries) {
    const source = `${entry.manifest.name}@${entry.manifest.version}`;
    if (value.excluded.includes(source)) continue;
    send({ type: 'initializing', source });
    const loaded = await load(entry, value, schemas, send);
    if (!loaded.ok) { send({ type: 'refused', source, error: loaded.error }); return; }
    stages.push(loaded.value);
  }
  if (value.runtime) {
    const opened = await control(value.runtime, stages, schemas);
    if (!opened.ok) { send({ type: 'refused', source: '', error: { code: 'io', message: opened.error.message } }); return; }
    endpoint = opened.value;
    void endpoint.finished().then(result => { if (!result.ok) send({ type: 'refused', source: '', error: { code: 'io', message: 'The environment monitor endpoint closed.' } }); });
  }
  send({ type: 'ready', sources: stages.map(stage => stage.source) });
}

if (Buffer.byteLength(JSON.stringify(setup)) > limits.messageBytes || !check(setup)) throw new Error('The inherited environment setup is invalid.');
port.on('message', (value: unknown) => {
  if (!command(value)) { send({ type: 'refused', source: '', error: { code: 'invalid-args', message: 'The monitor command violates its schema.' } }); port.close(); return; }
  void shutdown().then(() => { port.close(); });
});
await initialize(setup);

async function shutdown(): Promise<void> {
  endpoint?.close(); if (endpoint) await endpoint.finished();
  for (const stage of stages) {
    try { await stage.shutdown?.(); }
    catch { send({ type: 'refused', source: stage.source, error: { code: 'io', message: `${stage.source} shutdown failed.` } }); }
  }
}
