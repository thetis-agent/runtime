/** Script only the HTTP vendor while exercising real reservations and normalization; PR-001–012. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCap, RequestEvent } from '../../contracts/provider/types.ts';
import { Schemas, isObject } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import { providerFixture, collect, request, stream } from '../../test/provider-fixture.ts';
import { create } from './index.ts';
import type { Fetcher } from './index.ts';

const model: ModelCap = { id: 'scripted', contextWindow: 200000, maxOutput: 4096, tools: true, images: false, seed: true, reasoning: true, cache: 'explicit', price: { in: 1, out: 2, cachedRead: 0.1, cachedWrite: 1.25 } };
const usage = { cost: 0.005, prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 90 } };

function response(chunks: readonly unknown[]): Response {
  const data = Buffer.from(chunks.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= data.length) { controller.close(); return; }
    controller.enqueue(data.subarray(offset, offset + 7)); offset += 7;
  } }));
}

async function fixture(fetcher?: Fetcher, cost = 10) {
  const f = providerFixture([], cost); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const bodies: unknown[] = []; let calls = 0;
  const provider = create({ endpoint: 'https://vendor.invalid/chat/completions', key: 'secret-vendor-key', models: [model], deadlineMs: 10 }, schemas, clock, f.authority, f.budgets, (url, init) => {
    calls++; assert.equal(init.redirect, 'error'); assert.equal(typeof init.body, 'string');
    if (typeof init.body !== 'string') throw new Error('The vendor body must be JSON.');
    const parsed: unknown = JSON.parse(init.body); bodies.push(parsed);
    return fetcher ? fetcher(url, init) : Promise.resolve(response([
      { choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage }
    ]));
  });
  return { ...f, provider, schemas, clock, bodies, calls: () => calls };
}

await test('PR-001 compatible describe is local and declares complete model capabilities', async () => {
  const f = await fixture(); const result = await f.provider.describe(); assert.ok(result.ok);
  assert.ok(f.schemas.validator('provider', 'describeResponse')(result.value)); assert.deepEqual(result.value.models, [model]); assert.equal(f.calls(), 0);
});

await test('PR-003 compatible final accounting follows repeated finish markers and precedes stop', async () => {
  const f = await fixture(); const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
  assert.deepEqual(events.map(event => event.type), ['start', 'delta.text', 'usage', 'stop']);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0]?.counters['cost'], usage.cost);
  for (const event of events) assert.ok(f.schemas.validator('provider', 'responseEvent')(event));
  assert.equal(JSON.stringify(events).includes('secret-vendor-key'), false);
});

await test('PR-002 compatible prefix bytes remain stable and PR-005 unknown options never reach the vendor', async () => {
  const f = await fixture();
  for (let turn = 0; turn < 2; turn++) await collect(f.provider.run(stream(request('fixed', { unknown: 1, options: { mystery: 'ignore', maxTokens: 100 } })), f.token, new AbortController().signal));
  assert.deepEqual(f.bodies[0], f.bodies[1]); const body = f.bodies[0]; assert.ok(isObject(body));
  assert.equal(body['max_tokens'], 100); assert.equal(Object.hasOwn(body, 'unknown'), false); assert.equal(Object.hasOwn(body, 'mystery'), false);
});

await test('PR-006 compatible tool fragments retain one call id and parse after concatenation', async () => {
  const f = await fixture(() => Promise.resolve(response([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage }
  ])));
  const frames = request(); frames.splice(-1, 0, { type: 'tool', name: 'read', description: 'Read', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } });
  const events = await collect(f.provider.run(stream(frames), f.token, new AbortController().signal));
  const calls = events.filter(event => event.type === 'delta.tool_call'); assert.deepEqual(calls.map(event => event.callId), ['call-1', 'call-1']);
  assert.equal(calls[0]?.name, 'read'); const args: unknown = JSON.parse(calls.map(event => event.args).join('')); assert.deepEqual(args, { path: 'a' });
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool_calls' });
});

await test('PR-007 compatible reasoning precedes text and its opaque details survive replay', async () => {
  const details = [{ type: 'reasoning.encrypted', data: 'opaque', index: 0 }];
  const f = await fixture(() => Promise.resolve(response([
    { choices: [{ delta: { reasoning: 'reason', reasoning_details: details } }] },
    { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }], usage }
  ])));
  const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
  const reasoning = events.find(event => event.type === 'delta.reasoning'); assert.ok(reasoning);
  assert.ok(events.indexOf(reasoning) < events.findIndex(event => event.type === 'delta.text'));
  const frames: RequestEvent[] = [...request().slice(0, -1), { type: 'message', role: 'assistant', content: [{ type: 'reasoning', opaque: reasoning.opaque }] }, { type: 'end' }];
  await collect(f.provider.run(stream(frames), f.token, new AbortController().signal));
  const body = f.bodies[1]; assert.ok(isObject(body)); const messages: unknown[] = Array.isArray(body['messages']) ? body['messages'] : [];
  const assistant = messages.at(-1); assert.ok(isObject(assistant)); assert.deepEqual(assistant['reasoning_details'], details);
});

for (const [status, code] of [[401, 'auth'], [429, 'rate-limit'], [402, 'budget'], [413, 'context'], [408, 'deadline'], [503, 'provider']] satisfies [number, string][]) {
  await test(`${status === 401 ? 'PR-008' : status === 429 ? 'PR-009' : 'Provider HTTP error'} ${String(status)} maps to ${code} without retries or error-body leakage`, async () => {
    const f = await fixture(() => Promise.resolve(new Response('secret-vendor-key', { status })));
    const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
    assert.equal(f.calls(), 1); const last = events.at(-1); assert.ok(last?.type === 'error'); assert.equal(last.code, code);
    assert.equal(JSON.stringify(events).includes('secret-vendor-key'), false);
  });
}

await test('PR-010 compatible budget refusal precedes any HTTP request', async () => {
  const f = await fixture(undefined, 0.001); const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
  const last = events.at(-1); assert.ok(last?.type === 'error'); assert.equal(last.code, 'budget'); assert.match(last.message, /daily-cost/); assert.equal(f.calls(), 0);
});

await test('PR-012 compatible unknown callers never reach HTTP', async () => {
  const f = await fixture(); const events = await collect(f.provider.run(stream(request()), 'unknown', new AbortController().signal));
  const last = events.at(-1); assert.ok(last?.type === 'error'); assert.equal(last.code, 'auth'); assert.equal(f.calls(), 0);
});

await test('PR-004 compatible cancellation aborts the HTTP stream and reports before terminal cancel', async () => {
  let closed = false;
  const f = await fixture((_url, init) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      init.signal?.addEventListener('abort', () => { closed = true; controller.error(new Error('cancelled')); }, { once: true });
    }
  }))));
  const controller = new AbortController(); const events = [];
  for await (const event of f.provider.run(stream(request()), f.token, controller.signal)) {
    events.push(event); if (event.type === 'delta.text') controller.abort();
    if (event.type === 'stop') assert.equal(f.reports.length, 1);
  }
  assert.equal(closed, true); assert.deepEqual(events.at(-1), { type: 'stop', reason: 'cancel' });
});

await test('Compatible HTTP deadlines use the injected clock and abort the pending vendor', async () => {
  const started = Promise.withResolvers<undefined>();
  const f = await fixture((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { reject(new Error('deadline')); }, { once: true }); started.resolve(undefined);
  }));
  const result = collect(f.provider.run(stream(request()), f.token, new AbortController().signal)); await started.promise; f.clock.advance(10);
  const last = (await result).at(-1); assert.ok(last?.type === 'error'); assert.equal(last.code, 'deadline'); assert.equal(f.calls(), 1);
});

await test('Compatible malformed accounting and interrupted streams cannot become successful completions', async () => {
  for (const accounting of [{ cost: -1 }, {}, { cost: 'invalid' }]) {
    const f = await fixture(() => Promise.resolve(response([{ choices: [{ delta: {}, finish_reason: 'stop' }], usage: accounting }])));
    const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal));
    assert.ok(events.at(-1)?.type === 'error'); assert.equal(events.some(event => event.type === 'stop'), false);
  }
  const f = await fixture(() => Promise.resolve(new Response('data: {"choices":[]}\n\n')));
  const events = await collect(f.provider.run(stream(request()), f.token, new AbortController().signal)); assert.ok(events.at(-1)?.type === 'error');
});

await test('PR-010 OpenRouter routing carries the reviewed price ceilings and cannot add per-request charges', async () => {
  const f = await fixture(); let body: unknown;
  const provider = create({ endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: 'test-key', models: [model] }, f.schemas, f.clock, f.authority, f.budgets, (_url, init) => {
    if (typeof init.body !== 'string') throw new Error('The vendor body must be JSON.');
    body = JSON.parse(init.body); return Promise.resolve(response([{ choices: [{ delta: {}, finish_reason: 'stop' }], usage }]));
  });
  await collect(provider.run(stream(request()), f.token, new AbortController().signal));
  assert.ok(isObject(body)); assert.deepEqual(body['provider'], { max_price: { prompt: 1, completion: 2, request: 0 } });
});
