/** Exercise real paid turns only by explicit operator invocation, never in the offline suite; PR-010, PR-013, KS-004. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { descriptor } from '@/lib/files/descriptor.ts';
import { Secrets } from '@/kernel/secrets/index.ts';
import { runtimeFixture, revision, people } from '@/test/runtime-fixture.ts';
import { kernelProcess } from '@/test/kernel-process.ts';
import { discover } from '@/lib/package-loader/index.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { releaseDigest } from '@/lib/deployment/release.ts';
import { administrator } from '@/test/default-act.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Target } from '@/kernel/boundary/runtime.ts';
const limits = { model: 'openai/gpt-5.6-sol', contextWindow: 2048, maxOutput: 128, accountCost: 0.02, requests: 2, replyBytes: 1048576, replyFrames: 4096 };

async function command(endpoint: string, args: string[]): Promise<unknown[]> {
  const opened = await connect(endpoint); assert.ok(opened.ok);
  const frames: unknown[] = []; let bytes = 0;
  try {
    assert.ok((await send(opened.value, { args })).ok);
    for await (const frame of socketFrames(opened.value)) {
      assert.ok(frame.ok); bytes += Buffer.byteLength(JSON.stringify(frame.value));
      assert.ok(bytes <= limits.replyBytes && frames.length < limits.replyFrames); frames.push(frame.value);
    }
    return frames;
  } finally { opened.value.destroy(); }
}

async function conversation(endpoint: string, person: string): Promise<void> {
  const created = (await command(endpoint, ['new'])).at(-1); assert.ok(isObject(created) && created['ok'] === true && isObject(created['value']) && typeof created['value']['id'] === 'string');
  for (let turn = 0; turn < limits.requests; turn++) {
    const response = await command(endpoint, ['send', created['value']['id'], `Reply briefly to ${person}: this is live acceptance turn ${String(turn + 1)}.`]);
    const completed = response.at(-1); assert.ok(isObject(completed) && completed['ok'] === true, 'The live turn did not complete.');
    const events = response.flatMap(frame => { const values: unknown[] = isObject(frame) && isObject(frame['value']) && Array.isArray(frame['value']['events']) ? frame['value']['events'] : []; return values; });
    assert.ok(events.some((event: unknown) => isObject(event) && event['type'] === 'end' && isObject(event['payload']) && event['payload']['reason'] === 'answer'), 'The live stream did not end with an answer.');
  }
}

async function run(key: Buffer): Promise<void> {
  const fixture = await runtimeFixture(); const root = await mkdtemp('/tmp/lo-'); const masterKey = randomBytes(32);
  try {
    const environments = await Promise.all(people.map(person => fixture.environment(person.id)));
    const entries = await discover(packagesRoot(), '/state/packages', {}, fixture.schemas); assert.ok(entries.ok);
    const source = entries.value.find(entry => entry.manifest.name === 'provider-openai-compatible'); assert.ok(source);
    const plan = await revision('provider-openai-compatible', 'service.ts');
    const shared: Target = { ...fixture.shared, entries: [source], revision: plan, profile: { rule: { name: 'live-acceptance', cost: limits.accountCost, requests: limits.requests, windowMs: 86400000 }, settings: {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', deadlineMs: 120000, models: [{ id: limits.model, contextWindow: limits.contextWindow, maxOutput: limits.maxOutput, tools: true, images: false, seed: true, cache: 'implicit', price: { in: 2, out: 10, cachedRead: 0.2 } }]
    } }, registration: { package: source.manifest.name, id: 'provider', declared: { id: 'provider', cmd: 'node', args: [plan.plan.entry], env: { LLM_KEY: 'secret/llm-key' }, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'egress' } } };
    for (const environment of environments) { const runtime = environment.profile['runtime']; assert.ok(isObject(runtime)); runtime['model'] = limits.model; runtime['modelOptions'] = { reasoning: { effort: 'none' } }; }
    const clients: Target[] = await Promise.all(people.map(async person => ({ id: `${person.id}-cli`, owner: person.id, scope: 'person', environment: false, entries: [], services: [person.id], state: fixture.shared.state, profile: {},
      revision: await revision('cli', 'service.ts', [{ source: `service:${person.id}`, path: '/services/environment', mode: 'ro' }]) })));
    const targets = [shared, ...environments, ...clients]; const path = join(root, 'configuration.json');
    const secrets = await Secrets.open(join(root, 'sealed'), masterKey); assert.ok(secrets.ok);
    assert.ok((await secrets.value.set(administrator, 'kernel', { scope: 'deployment', name: 'llm-key', value: key.toString('utf8') })).ok);
    await writeFile(path, JSON.stringify({ version: 1, root, cgroup: '/cgroup', identity: { people: [administrator, ...people], bindings: [], authorities: {} }, targets, trusted: { origin: 'https://kernel.test', socket: join(root, 'origin.sock'), keyFd: 3, administrator: administrator.id, baseline: 1, digest: releaseDigest(targets), releases: [], plans: [] } }));
    assert.ok((await fixture.runtime.close()).ok);
    const kernel = await kernelProcess(path, true, masterKey);
    try {
      const { createHash } = await import('node:crypto');
      for (const person of people) {
        const id = createHash('sha256').update(`${person.id}-cli`).digest('base64url');
        await conversation(join(root, 'targets', id, 'runs/public/current.sock'), person.id);
      }
      const rows = await readFile(join(root, 'observed.jsonl'), 'utf8'); assert.ok(!rows.includes(key.toString('utf8')));
      process.stdout.write(`${JSON.stringify({ measurement: 'live-openrouter', model: limits.model, accounts: people.length, turns: people.length * limits.requests, maximumCost: people.length * limits.accountCost, observedRows: rows.trim().split('\n').length })}\n`);
    } finally { await kernel.close(); }
  } finally { masterKey.fill(0); await fixture.close(); await rm(root, { recursive: true, force: true }); }
}

const key = await descriptor(3, Number(process.argv[2]));
if (!key.ok) throw new Error(key.error.message);
try { await run(key.value); } finally { key.value.fill(0); }
