/** Exercise the exact publication key step without credentials or candidate execution; implementation note 0052, implementation note 0055. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isObject } from '@/lib/schema/index.ts';

const exec = promisify(execFile);
const limits = { timeout: 10000, maxBuffer: 65536 };
const environment = { PATH: '/usr/bin:/bin' };
const object = (value: unknown): Record<string, unknown> => { assert.ok(isObject(value)); return value; };
async function workflow(repository: 'runtime' | 'packages'): Promise<Record<string, unknown>> {
  const path = repository === 'runtime' ? '/workspace/.github/workflows/release.yml' : '/workspace/packages/.github/workflows/release.yml';
  const value: unknown = parse(await readFile(path, 'utf8')); return object(value);
}
function steps(workflow: Record<string, unknown>, job: string): Record<string, unknown>[] {
  const list = object(object(workflow['jobs'])[job])['steps']; assert.ok(Array.isArray(list));
  return list.map((value: unknown) => object(value));
}
function keyScript(workflow: Record<string, unknown>): string {
  const step = steps(workflow, 'publish').find(step => step['id'] === 'signing_key'); assert.ok(step);
  const script = step['run']; assert.equal(typeof script, 'string'); assert.ok(typeof script === 'string'); return script;
}
async function load(script: string, secret: string, directory: string): Promise<void> {
  await mkdir(directory);
  await exec('/bin/bash', ['-c', script], { ...limits, env: { ...environment, RELEASE_SIGNING_KEY: secret, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, 'outputs') } });
}

await test('the kernel boundary gate fails closed on missing inputs and scans discovered package names', async () => {
  const root = await mkdtemp('/tmp/kernel-boundary-');
  const script = '/workspace/.github/scripts/kernel-boundary.sh';
  try {
    await mkdir(join(root, 'kernel')); await mkdir(join(root, 'packages'));
    const run = (packages?: string) => exec('/bin/bash', [script], { ...limits, cwd: root,
      env: { ...environment, ...(packages === undefined ? {} : { THETIS_PACKAGES: packages }) } });
    await assert.rejects(run(), /Set THETIS_PACKAGES/u);
    await assert.rejects(run(join(root, 'absent')));
    await assert.rejects(run(join(root, 'packages')));
    await mkdir(join(root, 'packages/vendor-adapter'));
    await writeFile(join(root, 'packages/vendor-adapter/package.json'), JSON.stringify({ name: '@thetis/vendor-adapter' }));
    await writeFile(join(root, 'kernel/index.ts'), 'export const boundary = true;\n');
    await run(join(root, 'packages'));
    await writeFile(join(root, 'kernel/index.ts'), 'export const vendor = "vendor-adapter";\n');
    await assert.rejects(run(join(root, 'packages')), error => {
      assert.ok(isObject(error)); assert.equal(error['code'], 1);
      assert.match(String(error['stdout']), /vendor-adapter/u); return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('scheduled CI cannot cancel the main push whose candidate a release needs', async () => {
  for (const root of ['/workspace', '/workspace/packages']) {
    const config: unknown = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
    const concurrency = object(object(config)['concurrency']);
    assert.match(String(concurrency['group']), /github\.event_name/u);
    assert.equal(concurrency['cancel-in-progress'], true);
  }
});

await test('release publication requires a successful exact CI candidate and isolates signing from candidate execution', async () => {
  const runtime = await workflow('runtime'); const packages = await workflow('packages');
  assert.equal(keyScript(runtime), keyScript(packages).replaceAll('zero-release-key', 'thetis-release-key'));
  const selected = steps(runtime, 'build').find(step => step['id'] === 'candidate'); assert.ok(selected);
  assert.match(String(selected['run']), /head_sha=\$RELEASE_COMMIT&status=success/u);
  assert.match(String(selected['run']), /\.runtime\.commit == \$commit/u);
  assert.match(String(selected['run']), /\.packages\.commit == \$peer/u);
  assert.ok(!steps(runtime, 'build').some(step => String(step['uses']).includes('/actions/verify')));
  const peerAction = steps(packages, 'build').find(step => step['uses'] === './release-tools/actions/verify'); assert.ok(peerAction);
  assert.equal(object(peerAction['with'])['mode'], 'assemble');
  for (const config of [runtime, packages]) {
    const build = steps(config, 'build');
    assert.doesNotMatch(JSON.stringify(build), /RELEASE_SIGNING_KEY|Retain coverage/u);
    const publish = steps(config, 'publish');
    assert.ok(publish.every(step => !String(step['uses']).startsWith('actions/checkout@')));
    const cleanup = publish.find(step => step['name'] === 'Remove temporary signing key'); assert.ok(cleanup);
    assert.equal(cleanup['if'], '${{ always() }}');
  }
  const action: unknown = parse(await readFile('/workspace/.github/actions/verify/action.yml', 'utf8'));
  assert.equal(object(object(object(action)['inputs'])['mode'])['default'], 'verify');
  await assert.rejects(exec('/bin/bash', ['/workspace/.github/scripts/verify.sh', 'unknown'], { ...limits, env: environment }), /Unknown delivery mode/u);
});

await test('implementation note 0055 raw, transported and base64 release keys produce usable signatures with owner-only permissions', async () => {
  const root = await mkdtemp('/tmp/release-key-');
  try {
    const original = join(root, 'original');
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', original], { ...limits, env: environment });
    const raw = await readFile(original, 'utf8');
    const publicKey = (await readFile(`${original}.pub`, 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ');
    const script = keyScript(await workflow('runtime'));
    const forms = [raw, raw.trim(), raw.replaceAll('\n', '\r\n'), raw.replaceAll('\n', '\\n'), raw.replaceAll('\n', ' '), Buffer.from(raw).toString('base64')];
    for (const [index, value] of forms.entries()) {
      const directory = join(root, String(index)); await load(script, value, directory);
      const key = join(directory, 'thetis-release-key');
      assert.equal((await stat(key)).mode & 0o777, 0o600);
      assert.equal(await readFile(join(directory, 'outputs'), 'utf8'), `public_key=${publicKey}\n`);
      const payload = join(directory, 'SHA256SUMS'); await writeFile(payload, 'release signature fixture\n');
      const allowed = join(directory, 'allowed_signers'); await writeFile(allowed, `release@thetis-agent namespaces="zero-release" ${publicKey}\n`);
      await exec('ssh-keygen', ['-Y', 'sign', '-n', 'zero-release', '-f', key, payload], { ...limits, env: environment });
      const verified = await exec('/bin/bash', ['-c', 'ssh-keygen -Y verify -f "$1" -I release@thetis-agent -n zero-release -s "$2.sig" < "$2"', 'verify', allowed, payload], { ...limits, env: environment });
      assert.match(verified.stdout, /Good "zero-release" signature/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('implementation note 0055 invalid and encrypted signing keys fail without printing secrets or retaining a key file', async () => {
  const root = await mkdtemp('/tmp/release-key-refusal-');
  try {
    const encrypted = join(root, 'encrypted');
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'fixture-password', '-f', encrypted], { ...limits, env: environment });
    const script = keyScript(await workflow('runtime'));
    const forms = ['', 'not-a-private-key', 'A'.repeat(65537), await readFile(`${encrypted}.pub`, 'utf8'), await readFile(encrypted, 'utf8'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\n' + Buffer.from('openssh-key-v1\0truncated').toString('base64') + '\n-----END OPENSSH PRIVATE KEY-----\n'];
    for (const [index, secret] of forms.entries()) {
      const directory = join(root, String(index));
      await assert.rejects(load(script, secret, directory), error => {
        assert.ok(isObject(error) && typeof error['stderr'] === 'string' && typeof error['stdout'] === 'string');
        assert.match(error['stderr'], /::error::RELEASE_SIGNING_KEY/u);
        assert.equal(error['stdout'], '');
        if (secret) assert.ok(!error['stderr'].includes(secret));
        return true;
      });
      await assert.rejects(stat(join(directory, 'thetis-release-key')), /ENOENT/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
