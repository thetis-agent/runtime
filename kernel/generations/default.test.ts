/** Exercise default CAS through real frozen, probed and switched deployment processes; GN-005. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { revision as controlledRevision, endpointVersion } from '@/test/process-generation.ts';
import { runtimeFixture, people } from '@/test/runtime-fixture.ts';
import { administrator, reviewer, evidence, source } from '@/test/default-act.ts';
import type { Target } from '@/kernel/boundary/runtime.ts';
import { defaultAct } from '@/kernel/generations/default.ts';
import { isObject } from '@/lib/schema/index.ts';
import { releaseDigest } from '@/lib/deployment/release.ts';

await test('GN-005 two code-bound default digests race through the actual deployment process transaction', async () => {
  const fixture = await runtimeFixture(); const root = join(fixture.root, 'default'); await mkdir(root);
  try {
    const releases = ['first', 'second'].map(label => {
      const target = { ...fixture.shared, profile: { ...fixture.shared.profile, label } }; return { digest: releaseDigest([target]), targets: [target] };
    });
    const configured = { baseline: 1, digest: releaseDigest([fixture.shared]), releases, plans: releases.map(release => ({ source: source.target, plan: evidence(release.digest).plan })) };
    const made = await defaultAct({ root, schemas: fixture.schemas, journal: fixture.journal, runtime: fixture.runtime, administrator, now: () => fixture.clock.now() }, configured); assert.ok(made.ok);
    const codes = [];
    for (const release of releases) {
      assert.ok((await made.value.act.submit(source, evidence(release.digest).submission)).ok);
      const prepared = made.value.act.prepare(reviewer, 'kernel', { digest: release.digest, baseline: 1 }); assert.ok(prepared.ok);
      codes.push({ digest: release.digest, baseline: 1, code: prepared.value.code });
    }
    const results = await Promise.all(codes.map(params => made.value.act.set(reviewer, 'kernel', params)));
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results)); assert.ok(results.some(result => !result.ok && result.error.code === 'baseline-moved'));
    assert.equal(made.value.machine.view.current.n, 2); const status = fixture.runtime.status(administrator, 'shared'); assert.ok(status.ok); assert.equal(status.value['generation'], 2);
    const person = people[0]; assert.ok(person); assert.ok((await fixture.runtime.start(await fixture.environment(person.id))).ok);
    const conversation = await fixture.runtime.session(person, 'session.create', { surface: 'post-default' }); assert.ok(conversation.ok);
    const current: unknown = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')); assert.ok(isObject(current)); assert.equal(current['baseline'], 2);
    const rows = await fixture.rows(); assert.ok(rows.includes('all deployment writers frozen')); assert.ok(rows.includes('all deployment private probes passed'));
  } finally { await fixture.close(); }
});

await test('GN-005 a later serving failure restores every already-committed default member and its frozen state', async () => {
  const fixture = await runtimeFixture(); const root = join(fixture.root, 'default'); await mkdir(root); await mkdir(join(fixture.root, 'work'));
  await writeFile(join(fixture.shared.state, 'value.json'), '{"version":1}');
  try {
    const old = { ...fixture.shared, id: 'secondary', profile: {}, revision: await controlledRevision(fixture.root, 'old', 'healthy', 1, false) };
    const secondary: Target = { ...old }; delete secondary.registration;
    assert.ok((await fixture.runtime.start(secondary)).ok);
    const targets = [{ ...fixture.shared, profile: { ...fixture.shared.profile, label: 'candidate' } }, { ...secondary, revision: await controlledRevision(fixture.root, 'new', 'fail-serving', 2, true) }];
    const digest = releaseDigest(targets); const material = evidence(digest);
    const made = await defaultAct({ root, schemas: fixture.schemas, journal: fixture.journal, runtime: fixture.runtime, administrator, now: () => fixture.clock.now() }, { baseline: 1, digest: releaseDigest([fixture.shared, secondary]), releases: [{ digest, targets }], plans: [{ source: source.target, plan: material.plan }] }); assert.ok(made.ok);
    assert.ok((await made.value.act.submit(source, material.submission)).ok); const prepared = made.value.act.prepare(reviewer, 'kernel', { digest, baseline: 1 }); assert.ok(prepared.ok);
    const result = await made.value.act.set(reviewer, 'kernel', { digest, baseline: 1, code: prepared.value.code }); assert.ok(!result.ok);
    assert.equal(made.value.machine.view.state, 'LIVE'); assert.equal(made.value.machine.view.current.n, 3);
    const endpoint = fixture.runtime.endpoint('secondary'); assert.ok(endpoint.ok); assert.equal(await endpointVersion(endpoint.value), 'old');
    for (const id of ['shared', 'secondary']) { const status = fixture.runtime.status(administrator, id); assert.ok(status.ok); assert.equal(status.value['state'], 'LIVE'); assert.equal(status.value['generation'], 3); }
    const rows = await fixture.rows(); assert.ok(rows.includes('post-commit.json')); assert.ok(rows.includes('"event":"undo"'));
  } finally { await fixture.close(); }
});
