/** Exercise the real tool wire, including cancellation and malformed replies; TS-001–004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ManualClock } from '@/lib/events/index.ts';
import { Schemas } from '@/lib/schema/index.ts';
import { send } from '@/lib/ndjson/socket.ts';
import type { CallRequest } from '@/contracts/turn-events/types.ts';
import { Service, serviceLimits } from './lifecycle.ts';
import { ToolClient, stageService } from './tool-client.ts';
import { toolServer } from './tool-server.ts';
import type { ToolHandler } from './tool-server.ts';

const request: CallRequest = { id: 'call', name: 'lookup', args: {}, mode: { readOnly: false, deny: [] }, roots: [], deadlineMs: 100, budget: { resultBytes: 1000 } };
async function fixture(handler: ToolHandler, invalid = false) {
  const root = await mkdtemp('/tmp/tool-wire-'); const path = join(root, 'service.sock');
  const time = new ManualClock(); const schemas = new Schemas(); await schemas.load();
  const service = new Service(time, serviceLimits, 'io'); const client = new ToolClient('inherited-token', schemas, time);
  const opened = await service.open(path, invalid ? async ({ socket }) => send(socket, { id: 'wrong', ok: true }) : await toolServer(schemas, handler), () => undefined); assert.ok(opened.ok);
  return { path, client, time, async close() { client.close(); await service.stop(); await rm(root, { recursive: true, force: true }); } };
}
await test('TS-001 a tool exchange carries inherited evidence and accepts unknown answer fields', async () => {
  const f = await fixture((call, token) => {
    assert.equal(token, 'inherited-token'); assert.deepEqual(call, request);
    return Promise.resolve({ id: call.id, ok: true, content: [{ type: 'text', text: 'result' }], future: 1 });
  });
  try { assert.equal((await f.client.call(f.path, request)).ok, true); } finally { await f.close(); }
});
await test('TS-002 mismatched reply IDs and missing sockets are refused', async () => {
  const f = await fixture(() => Promise.resolve({ id: 'call', ok: true }), true);
  try {
    assert.equal((await f.client.call(f.path, request)).error?.code, 'io');
    assert.equal((await f.client.call(`${f.path}-missing`, request)).error?.code, 'io');
  } finally { await f.close(); }
});
for (const reason of ['deadline', 'abort', 'close']) await test(`TS-003 ${reason} closes the socket and cancels the handler`, async () => {
  const started = Promise.withResolvers<undefined>(); const ended = Promise.withResolvers<undefined>();
  const f = await fixture((call, _token, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { ended.resolve(undefined); resolve({ id: call.id, ok: true }); }, { once: true }); started.resolve(undefined);
  }));
  try {
    const controller = new AbortController(); const pending = f.client.call(f.path, request, controller.signal); await started.promise;
    if (reason === 'deadline') f.time.advance(100); else if (reason === 'abort') controller.abort(); else f.client.close();
    assert.equal((await pending).error?.code, 'deadline'); await ended.promise;
  } finally { await f.close(); }
});
await test('TS-004 packages cannot resolve undeclared or unmounted services', async () => {
  const service = stageService({ path: '', state: '', settings: {}, manifest: { name: 'fixture', version: '1.0.0', requires: {}, provides: {}, settings: {}, envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } } } },
    { profile: {}, provided: {}, spaces: [], entries: [], excluded: [] }, new Schemas());
  try { assert.equal((await service.call('service/private', request)).error?.code, 'gone'); } finally { service.close(); }
});
