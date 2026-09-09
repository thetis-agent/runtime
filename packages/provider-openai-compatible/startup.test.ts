/** Keep secret delivery and startup policy distinct without vendor access; PR-010, PR-013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from './startup.ts';
import { providerFixture } from '../../test/provider-fixture.ts';
import { Schemas } from '../../lib/schema/index.ts';
import { ManualClock } from '../../lib/events/index.ts';
import type { ModelCap } from '../../contracts/provider/types.ts';

const model: ModelCap = { id: 'model', contextWindow: 100, maxOutput: 10, tools: true, images: false, cache: 'none', seed: false, reasoning: false };

await test('PR-013 adapter startup takes its secret separately and materializes only declared settings', async () => {
  const fixture = providerFixture(); const schemas = new Schemas(); await schemas.load();
  const configured = await configure({ models: [model] }, 'spawn-only-test-key', fixture.authority, fixture.budgets, schemas, new ManualClock());
  assert.ok(configured.ok); const description = await configured.value.describe(); assert.ok(description.ok);
  assert.deepEqual(description.value.models, [model]); assert.ok(!JSON.stringify(description).includes('spawn-only-test-key'));
  const missing = await configure({ models: [model] }, undefined, fixture.authority, fixture.budgets, schemas, new ManualClock()); assert.ok(!missing.ok);
  assert.equal(missing.error.message, 'provider-openai-compatible 1.0.0 requires secret/llm-key *. Nothing in this profile provides it. No configured registry provides it.');
});

await test('PR-010 startup settings cannot replace policy or hide invalid model and endpoint declarations', async () => {
  const fixture = providerFixture(); const schemas = new Schemas(); await schemas.load(); const clock = new ManualClock();
  const invalid = [
    { models: [model], rule: { cost: 1000000 } }, { models: [] }, { models: [{ ...model, images: true }] },
    { models: [model], endpoint: 'broken' }, { models: [model], endpoint: 'http://vendor.invalid/' },
    { models: [model], endpoint: 'https://key@vendor.invalid/' }, { models: [model], deadlineMs: -1 }
  ];
  for (const settings of invalid) {
    const configured = await configure(settings, 'spawn-only-test-key', fixture.authority, fixture.budgets, schemas, clock);
    assert.ok(!configured.ok); assert.equal(configured.error.code, 'invalid-args'); assert.ok(!configured.error.message.includes('spawn-only-test-key'));
  }
  const missing = await configure({}, 'spawn-only-test-key', fixture.authority, fixture.budgets, schemas, clock); assert.ok(!missing.ok);
  assert.equal(missing.error.message, 'provider-openai-compatible 1.0.0 requires setting/models *. Nothing in this profile provides it. No configured registry provides it.');
  assert.equal(fixture.reports.length, 0);
});
