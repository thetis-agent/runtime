/** Exercise configuration admission through the actual kernel boot path; KS-005, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from '@/kernel/main.ts';
import { revision } from '@/test/runtime-fixture.ts';

await test('KS-010 configured kernel starts only a hash-verified sandbox target and refuses forged pins', async () => {
  const root = await mkdtemp('/tmp/boot-'); const state = join(root, 'state'); await mkdir(state);
  const plan = await revision('provider-mock', 'service.ts');
  const config = { version: 1, root: join(root, 'kernel'), cgroup: '/cgroup', identity: { people: [], bindings: [], authorities: {} }, targets: [{ id: 'shared', owner: '', scope: 'deployment', state, entries: [], services: [], revision: plan,
    profile: { rule: { name: 'cost', cost: 1, requests: 100, windowMs: 86400000 }, settings: {} } }] };
  const path = join(root, 'deployment.json'); await writeFile(path, JSON.stringify(config));
  try {
    const boot = await start(path); assert.ok(boot.ok, JSON.stringify(boot));
    assert.ok(boot.value.runtime.endpoint('shared').ok); assert.ok((await boot.value.close()).ok);
    for (const pin of Object.values(plan.pins)) pin.hash = `sha256:${'0'.repeat(64)}`;
    config.root = join(root, 'refused'); await writeFile(path, JSON.stringify(config));
    const refused = await start(path); assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'invalid-args');
  } finally { await rm(root, { recursive: true, force: true }); }
});
