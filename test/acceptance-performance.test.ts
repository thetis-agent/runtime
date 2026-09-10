/** Bound the actual trusted process and one idle sandbox under the approved ceiling; ADR 0041. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kernelProcess } from './kernel-process.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { isObject } from '../lib/result/index.ts';

const maximumRssBytes = 512000000;

async function resident(pid: number, descendants: boolean): Promise<number> {
  const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
  const kilobytes = /^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1]; assert.ok(kilobytes);
  let bytes = Number(kilobytes) * 1024;
  if (descendants) {
    const children = await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, 'utf8');
    for (const child of children.trim().split(/\s+/u).filter(Boolean)) bytes += await resident(Number(child), true);
  }
  return bytes;
}

await test('ADR 0041 kernel plus one actual idle environment uses at most 512 MB RSS', async () => {
  const fixture = await runtimeFixture();
  try {
    const environment = await fixture.environment('alice'); assert.ok((await fixture.runtime.close()).ok);
    const root = join(fixture.root, 'm'); const path = join(fixture.root, 'measurement.json');
    await writeFile(path, JSON.stringify({ version: 1, root, cgroup: '/cgroup', identity: { people: [{ id: 'alice', role: 'user', projects: [], observeOthers: false }], bindings: [], authorities: {} }, targets: [fixture.shared, environment] }));
    const running = await kernelProcess(path, false);
    try {
      const rows = (await readFile(join(root, 'observed.jsonl'), 'utf8')).trim().split('\n').map((row): unknown => JSON.parse(row));
      const started = rows.find(row => isObject(row) && row['target'] === 'alice' && row['kind'] === 'process.start');
      assert.ok(isObject(started) && isObject(started['data']) && typeof started['data']['pid'] === 'number', JSON.stringify(started));
      const kernel = await resident(running.pid, false); const sandbox = await resident(started['data']['pid'], true);
      process.stdout.write(`${JSON.stringify({ measurement: 'kernel-and-idle-environment-rss', kernel, environment: sandbox, bytes: kernel + sandbox, maximum: maximumRssBytes })}\n`);
      assert.ok(kernel + sandbox <= maximumRssBytes, `Kernel and idle environment require ${String(kernel + sandbox)} bytes RSS, exceeding ${String(maximumRssBytes)}.`);
    } finally { await running.close(); }
  } finally { await fixture.close(); }
});
