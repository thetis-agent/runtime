/** Exercise the actual PR peer-selection scripts with untrusted event data; ADR 0035. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isObject } from '@/lib/schema/index.ts';

const exec = promisify(execFile);
const commit = '0123456789abcdef0123456789abcdef01234567';
const roots = ['/workspace', '/workspace/packages'];
const object = (value: unknown): Record<string, unknown> => { assert.ok(isObject(value)); return value; };

async function script(root: string): Promise<string> {
  const config: unknown = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const workflow = object(config);
  assert.deepEqual(workflow['permissions'], { contents: 'read' });
  const jobs = object(workflow['jobs']);
  const steps = object(jobs['resolve'] ?? jobs['verify'])['steps']; assert.ok(Array.isArray(steps));
  const entries = steps.map((step: unknown) => object(step));
  const select = entries.find(step => step['id'] === 'peer'); assert.ok(select);
  const checkout = entries.find(step => isObject(step['with']) && step['with']['ref'] === '${{ steps.peer.outputs.ref }}'); assert.ok(checkout);
  const options = object(checkout['with']);
  assert.equal(options['repository'], root.endsWith('/packages') ? 'thetis-agent/runtime' : 'thetis-agent/packages');
  assert.equal(options['ref'], '${{ steps.peer.outputs.ref }}');
  assert.equal(options['persist-credentials'], false);
  const run = select['run']; assert.ok(typeof run === 'string'); return run;
}

async function select(run: string, event: unknown, input = '', fallback = 'main'): Promise<string> {
  const root = await mkdtemp('/tmp/ci-peer-');
  try {
    const path = join(root, 'event.json'); const output = join(root, 'output');
    await writeFile(path, JSON.stringify(event));
    await exec('/bin/bash', ['-e', '-o', 'pipefail', '-c', run], {
      timeout: 10000, maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', INPUT_PEER_REF: input, DEFAULT_PEER_REF: fallback, GITHUB_EVENT_PATH: path, GITHUB_OUTPUT: output },
    });
    return await readFile(output, 'utf8');
  } finally { await rm(root, { recursive: true, force: true }); }
}

await test('CI selects the exact PR peer commit without evaluating body text or changing the peer repository', async () => {
  for (const root of roots) {
    const run = await script(root);
    const body = `Review $(exit 7) and \`exit 8\`.\r\nThetis peer commit: ${commit}\r\n`;
    assert.equal(await select(run, { pull_request: { body } }), `ref=${commit}\n`);
  }
});

await test('CI retains configured defaults outside coordinated PRs and accepts an explicit manual override', async () => {
  for (const root of roots) {
    const run = await script(root);
    for (const event of [{}, { pull_request: { body: null } }, { pull_request: { body: 'Ordinary change.' } }]) {
      assert.equal(await select(run, event), 'ref=main\n');
      assert.equal(await select(run, event, '', commit), `ref=${commit}\n`);
    }
    assert.equal(await select(run, {}, 'feature/peer'), 'ref=feature/peer\n');
    assert.equal(await select(run, { pull_request: { body: 'Thetis peer commit: invalid' } }, commit), `ref=${commit}\n`);
  }
});

await test('CI rejects ambiguous, abbreviated and injected peer pins instead of silently testing another revision', async () => {
  for (const root of roots) {
    const run = await script(root);
    for (const pin of ['main', commit.slice(0, 7), commit.toUpperCase(), `$(exit 7)`, `${commit} extra`, '']) {
      await assert.rejects(select(run, { pull_request: { body: `Thetis peer commit: ${pin}` } }), /Use one full Thetis peer commit/u);
    }
    await assert.rejects(select(run, { pull_request: { body: `Thetis peer commit: ${commit}\nThetis peer commit: ${commit}` } }), /Use one full Thetis peer commit/u);
    await assert.rejects(select(run, {}, `${commit}\nref=main`), /The peer reference must be one line/u);
  }
});
