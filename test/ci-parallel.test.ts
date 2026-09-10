/** Keep all parallel gates mandatory before delivery can claim complete verification; ADR 0035. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isObject } from '@/lib/schema/index.ts';

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> => { assert.ok(isObject(value)); return value; };
const environment = { PATH: '/usr/bin:/bin', RESOLVE_RESULT: 'success', GATES_RESULT: 'success', TEST_RESULT: 'success',
  RUNTIME_COMMIT: 'a'.repeat(40), PACKAGES_COMMIT: 'b'.repeat(40) };
const files = ['thetis-distribution.tar.gz', 'package.json', 'profile.lock.json', 'registry.json', 'registry.bundle', 'provenance.json', 'platform.txt', 'kernel-pins.json', 'install.sh'];
const run = (directory: string, env = environment) => exec('/bin/bash', ['/workspace/.github/scripts/finalize-ci.sh', directory], { env, timeout: 10000, maxBuffer: 65536 });

async function delivery(root: string): Promise<void> {
  for (const name of files) await writeFile(join(root, name), 'fixture');
  await writeFile(join(root, 'provenance.json'), JSON.stringify({ runtime: { commit: environment.RUNTIME_COMMIT }, packages: { commit: environment.PACKAGES_COMMIT }, delivery: { mode: 'gates' } }));
  const checksums = await exec('sha256sum', files, { cwd: root });
  await writeFile(join(root, 'SHA256SUMS'), checksums.stdout);
}

await test('CI divides the suite into four independent jobs and retains a required aggregate check', async () => {
  // The runtime tooling lands first; its peer's old workflow remains supported during rollout.
  const config: unknown = parse(await readFile('/workspace/.github/workflows/ci.yml', 'utf8'));
  const jobs = object(object(config)['jobs']); const tests = object(jobs['test']); const strategy = object(tests['strategy']);
  assert.deepEqual(object(strategy['matrix'])['shard'], [1, 2, 3, 4]);
  assert.equal(strategy['fail-fast'], false); assert.equal(strategy['max-parallel'], 4);
  assert.equal(tests['needs'], 'resolve'); assert.equal(object(jobs['gates'])['needs'], 'resolve');
  const final = object(jobs['verify']); assert.equal(final['name'], 'Full CI');
  assert.deepEqual(final['needs'], ['resolve', 'gates', 'test']); assert.equal(final['if'], '${{ always() }}');
  for (const job of ['gates', 'test']) {
    const steps = object(jobs[job])['steps']; assert.ok(Array.isArray(steps));
    const checkouts = steps.map((step: unknown) => object(step)).filter(step => String(step['uses']).startsWith('actions/checkout@'));
    assert.deepEqual(checkouts.map(step => object(step['with'])['ref']), ['${{ needs.resolve.outputs.runtime }}', '${{ needs.resolve.outputs.packages }}']);
  }
});

await test('failed, cancelled, skipped and missing upstream results cannot finalize a candidate', async () => {
  const root = await mkdtemp('/tmp/ci-candidate-');
  try {
    await delivery(root); const before = await readFile(join(root, 'provenance.json'), 'utf8');
    for (const key of ['RESOLVE_RESULT', 'GATES_RESULT', 'TEST_RESULT']) {
      for (const result of ['failure', 'cancelled', 'skipped', '']) await assert.rejects(run(root, { ...environment, [key]: result }));
    }
    assert.equal(await readFile(join(root, 'provenance.json'), 'utf8'), before);
    await run(root);
    const provenance: unknown = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
    assert.equal(object(object(provenance)['delivery'])['mode'], 'verify');
    await exec('sha256sum', ['--check', '--strict', 'SHA256SUMS'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('successful jobs cannot finalize a modified artifact or a different source pair', async () => {
  const root = await mkdtemp('/tmp/ci-candidate-refusal-');
  try {
    await delivery(root);
    await assert.rejects(run(root, { ...environment, RUNTIME_COMMIT: 'c'.repeat(40) }));
    await assert.rejects(run(root, { ...environment, PACKAGES_COMMIT: 'c'.repeat(40) }));
    await writeFile(join(root, 'registry.bundle'), 'tampered'); await assert.rejects(run(root));
    const provenance: unknown = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
    assert.equal(object(object(provenance)['delivery'])['mode'], 'gates');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('CI shard mode refuses missing, extra and invalid partitions before starting work', async () => {
  for (const args of [['shard'], ['shard', '0/4'], ['shard', '5/4'], ['shard', '1/3'], ['gates', '1/4'], ['verify', '1/4']]) {
    await assert.rejects(exec('/bin/bash', ['/workspace/.github/scripts/verify.sh', ...args], { env: { PATH: '/usr/bin:/bin' } }));
  }
});
