/** Defend portable coverage attribution and refusal of misleading partial reports; ADR 0012, ADR 0035. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceFlags } from '@/lib/artifacts/index.ts';
import { Coverage, coverageFlags, coverageLimits, prepareCoverage, writeCoverage } from '@/scripts/coverage.ts';

const record = (source: string): string => `TN:\nSF:${source}\nFN:1,example\nFNDA:1,example\nFNF:2\nFNH:1\nBRDA:1,0,0,1\nBRF:4\nBRH:1\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n`;

await test('shard coverage distinguishes same-name methods and preserves anonymous identities when lazy functions appear', async () => {
  const script = `import reporter from '/workspace/scripts/coverage-reporter.mjs';
import { Readable } from 'node:stream';
const added = process.argv[1] === 'extra' ? [{ line: 2, name: 'lazy', count: 1 }] : [];
const functions = [...added, { line: 4, name: 'close', count: 0 }, { line: 8, name: 'close', count: 3 }, { line: 10, name: '', count: 1 }];
const file = { path: '/workspace/lib/example.ts', functions, totalFunctionCount: functions.length, coveredFunctionCount: functions.length - 1,
  lines: [{line: 4, count: 0}, {line: 8, count: 3}], totalLineCount: 2, coveredLineCount: 1,
  branches: [{line: 8, count: 3}], totalBranchCount: 1, coveredBranchCount: 1 };
for await (const chunk of reporter(Readable.from([{ type: 'test:coverage', data: { summary: { workingDirectory: '/workspace', files: [file] } } }]))) process.stdout.write(chunk);`;
  for (const mode of ['base', 'extra']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, mode], { timeout: 10000, maxBuffer: 65536 });
    assert.match(stdout, /^FNDA:0,close@4#0$/mu); assert.match(stdout, /^FNDA:3,close@8#0$/mu);
    assert.match(stdout, /^FNDA:1,\(anonymous\)@10#0$/mu); assert.match(stdout, /^BRDA:8,0,0,3$/mu);
    const coverage = new Coverage(); for (const line of stdout.split('\n')) coverage.line(line);
    assert.equal(coverage.finish().combined.functions.found, mode === 'base' ? 3 : 4);
  }
});

await test('coverage streams split records into portable runtime/package paths and weighted summaries', async () => {
  assert.equal(tmpdir(), '/tmp', 'Coverage must not enlarge the ordinary test temporary filesystem.');
  assert.equal(process.env.NODE_V8_COVERAGE, undefined, 'Coverage must not propagate into ordinary child environments.');
  const directory = await mkdtemp('/tmp/coverage-');
  try {
    await prepareCoverage(directory);
    const input = record('/workspace/kernel/main.ts') + record('packages/cli/update-notice.ts');
    const chunks = [...Buffer.from(input)].map(byte => Buffer.from([byte]));
    const result = await writeCoverage(Readable.from(chunks), directory);
    assert.deepEqual(result.combined, { files: 2, lines: { found: 4, hit: 2 }, functions: { found: 4, hit: 2 }, branches: { found: 8, hit: 2 } });
    assert.equal(result.runtime.files, 1); assert.equal(result.packages.files, 1);
    const lcov = await readFile(join(directory, 'lcov.info'), 'utf8');
    assert.match(lcov, /^SF:runtime\/kernel\/main.ts$/mu); assert.match(lcov, /^SF:packages\/cli\/update-notice.ts$/mu);
    assert.doesNotMatch(lcov, /\/workspace/u);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')), result);
    assert.match(await readFile(join(directory, 'summary.md'), 'utf8'), /50\.00% \(2\/4\)/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

await test('coverage refuses empty, truncated, escaping, repeated and impossible records', () => {
  for (const input of ['', 'SF:kernel/main.ts\n', record('/etc/passwd'), record('lib/../kernel/main.ts'), record('lib/code.test.ts'),
    record('lib/code.ts') + record('lib/code.ts'), record('lib/code.ts').replace('LH:1', 'LH:3'), record('lib/code.ts').replace('LF:2\n', ''),
    record('lib/code.ts').replace('LH:1', 'LH:NaN'), record('lib/code.ts').replace('LF:2', 'LF:2\nLF:2')]) {
    const coverage = new Coverage();
    assert.throws(() => { for (const line of input.split('\n')) coverage.line(line); coverage.finish(); }, /Coverage|coverage/u, input);
  }
  assert.throws(() => new Coverage().line('x'.repeat(coverageLimits.lineBytes + 1)), /byte limit/u);
});

await test('merged coverage accepts portable paths and strips only the exact aggregate workspace root', async () => {
  const directory = await mkdtemp('/tmp/coverage-merged-');
  try {
    const result = await writeCoverage(Readable.from([record('/build/runtime/lib/code.ts') + record('/build/packages/core/index.ts')]), directory, '/build');
    assert.equal(result.runtime.files, 1); assert.equal(result.packages.files, 1);
    const output = await readFile(join(directory, 'lcov.info'), 'utf8');
    assert.match(output, /^SF:runtime\/lib\/code.ts$/mu); assert.match(output, /^SF:packages\/core\/index.ts$/mu);
    for (const source of ['/build-other/runtime/lib/code.ts', '/elsewhere/lib/code.ts', 'runtime/../lib/code.ts', 'runtime/packages/core/index.ts']) {
      const coverage = new Coverage(); assert.throws(() => { for (const line of record(source).split('\n')) coverage.line(line); coverage.finish(); });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

await test('a failed coverage stream emits no summary and a fresh run removes stale report files', async () => {
  const directory = await mkdtemp('/tmp/coverage-');
  try {
    await writeFile(join(directory, 'summary.md'), 'stale success'); await writeFile(join(directory, 'unrelated'), 'keep');
    await prepareCoverage(directory);
    await assert.rejects(writeCoverage(Readable.from(['SF:lib/source.ts\nLF:2\n']), directory), /incomplete/u);
    await assert.rejects(readFile(join(directory, 'summary.md')), /ENOENT/u);
    assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

await test('a real failing Node test retains nonzero status and still supplies valid coverage', async () => {
  const directory = await mkdtemp('/tmp/coverage-failure-');
  try {
    const fixture = join(directory, 'failure.mjs');
    await writeFile(fixture, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select } from '/workspace/lib/update/policy.ts';
test('deliberate fixture failure', () => assert.equal(select('v0.1.0', ['v0.1.1'], 'fixes'), 'deliberate-failure'));
`);
    await prepareCoverage(directory);
    const child = spawn(process.execPath, [...sourceFlags(), '--test', ...coverageFlags(), fixture],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' }, timeout: 10000 });
    const closed = new Promise<number | null>(resolve => { child.once('error', () => { resolve(null); }); child.once('close', resolve); });
    assert.ok(child.stdout);
    const summary = await writeCoverage(child.stdout, directory);
    assert.equal(await closed, 1); assert.ok(summary.runtime.files > 0);
    assert.match(await readFile(join(directory, 'lcov.info'), 'utf8'), /SF:runtime\/lib\/update\/policy.ts/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
