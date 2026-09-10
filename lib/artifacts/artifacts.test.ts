/** Defend deterministic artifacts, source locations, worker inheritance and fail-closed loading; ADR 0037, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildTree } from './build.ts';
import { flags, compile } from './index.ts';
import { verified } from './verify.mjs';
import { verifyTree } from './verify-tree.ts';
import { generateSupport } from './generate.ts';
import { isObject } from '../result/index.ts';

async function execute(path: string): Promise<{ code: number | null; output: string; error: string }> {
  const child = spawn(process.execPath, [...flags(), path], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000); let output = ''; let error = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); if (error.length > 16384) child.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, output, error }); });
  });
}
await test('ADR 0037 checked bootstrap bytes are fresh and generated artifacts preserve exact source positions', async () => {
  assert.ok(await generateSupport(true)); const root = await mkdtemp('/tmp/artifacts-'); const path = join(root, 'main.ts');
  try {
    const source = "const message: string = 'same location';\nthrow new Error(message);\n"; await writeFile(path, source);
    assert.ok(await buildTree(root, root)); assert.ok(await buildTree(root, root, true));
    const first = await readFile(`${path}.js`, 'utf8'); assert.equal(first.split('\n').length, source.split('\n').length);
    assert.equal(first.indexOf('throw'), source.indexOf('throw')); assert.ok((await verifyTree(root)).ok);
    await buildTree(root, root); assert.equal(await readFile(`${path}.js`, 'utf8'), first);
    const running = await execute(path); assert.notEqual(running.code, 0); assert.ok(running.error.includes(`${path}:2:7`));
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('ADR 0037 artifacts preserve relative TypeScript imports and worker URLs without source fallback', async () => {
  const root = await mkdtemp('/tmp/artifacts-');
  try {
    await writeFile(join(root, 'value.ts'), 'export const value: number = 37;\n');
    await writeFile(join(root, 'worker.ts'), "import {parentPort} from 'node:worker_threads'; import {value} from './value.ts'; parentPort?.postMessage(value);\n");
    await writeFile(join(root, 'main.ts'), "import {Worker} from 'node:worker_threads'; const worker = new Worker(new URL('./worker.ts', import.meta.url)); worker.once('message', value => process.stdout.write(String(value)));\n");
    assert.ok(await buildTree(root, root)); const running = await execute(join(root, 'main.ts'));
    assert.equal(running.code, 0, running.error); assert.equal(running.output, '37');
    await rm(join(root, 'value.ts.js')); const refused = await execute(join(root, 'main.ts')); assert.notEqual(refused.code, 0); assert.equal(refused.output, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('GN-002 missing, stale, tampered and incompatible artifacts never evaluate the source', async () => {
  const root = await mkdtemp('/tmp/artifacts-'); const path = join(root, 'main.ts');
  try {
    await writeFile(path, "process.stdout.write('must not run');\n"); assert.notEqual((await execute(path)).code, 0);
    for (const change of ['source', 'output', 'runtime', 'malformed']) {
      await buildTree(root, root);
      if (change === 'source') await writeFile(path, "process.stdout.write('changed source');\n");
      if (change === 'output') await writeFile(`${path}.js`, "process.stdout.write('changed output');\n");
      if (change === 'runtime') { const metadata: unknown = JSON.parse(await readFile(`${path}.artifact.json`, 'utf8')); assert.ok(isObject(metadata)); await writeFile(`${path}.artifact.json`, JSON.stringify({ ...metadata, runtime: 'v0.0.0' })); }
      if (change === 'malformed') await writeFile(`${path}.artifact.json`, '{}');
      const result = await execute(path); assert.notEqual(result.code, 0); assert.equal(result.output, ''); assert.ok(!(await verifyTree(root)).ok);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('GN-002 execution paths reject symlinks, oversized bytes and unsupported TypeScript while retaining unknown metadata', async () => {
  const root = await mkdtemp('/tmp/artifacts-'); const path = join(root, 'main.ts');
  try {
    await writeFile(path, 'export const value: number = 1;\n'); await buildTree(root, root);
    const metadata: unknown = JSON.parse(await readFile(`${path}.artifact.json`, 'utf8')); assert.ok(isObject(metadata));
    await writeFile(`${path}.artifact.json`, JSON.stringify({ ...metadata, extension: { ignored: true } })); assert.ok(verified(path).length);
    await symlink(path, join(root, 'alias.ts')); assert.throws(() => verified(join(root, 'alias.ts')), { code: 'outside-roots' }); await rm(join(root, 'alias.ts'));
    await rm(`${path}.js`); await symlink(path, `${path}.js`); assert.throws(() => verified(path), { code: 'outside-roots' }); await rm(`${path}.js`);
    await writeFile(path, ' '.repeat(1048577)); await assert.rejects(buildTree(root, root)); assert.throws(() => verified(path), { code: 'budget' });
    await writeFile(path, 'enum Unsupported { value }'); await assert.rejects(buildTree(root, root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
await test('ADR 0037 bounded compilation regenerates edited files without evaluating them or trusting supplied output', async () => {
  const root = await mkdtemp('/tmp/artifacts-'); const source = join(root, 'source');
  try {
    const { mkdir } = await import('node:fs/promises'); await mkdir(source);
    await writeFile(join(source, 'main.ts'), "throw new Error('never evaluated while building');\n");
    await writeFile(join(source, 'main.ts.js'), 'forged output');
    const destination = join(root, 'built'); const result = await compile(source, destination); assert.ok(result.ok, JSON.stringify(result));
    assert.ok((await verifyTree(destination)).ok); assert.equal(await readFile(join(source, 'main.ts.js'), 'utf8'), 'forged output');
    assert.ok(!(await compile(source, source)).ok); assert.ok(!(await compile('x'.repeat(4097), destination)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('ADR 0037 unchanged artifacts come only from trusted pins and edited schemas regenerate guards', async () => {
  const root = await mkdtemp('/tmp/artifacts-'); const previous = join(root, 'previous'); const source = join(root, 'source');
  try {
    await mkdir(previous); await writeFile(join(previous, 'main.ts'), 'export const value: number = 1;\n'); await buildTree(previous, previous);
    await cp(previous, source, { recursive: true }); await writeFile(join(source, 'main.ts.js'), 'forged edited output');
    await writeFile(join(source, 'schema.json'), JSON.stringify({ $id: 'thetis://test/edited-schema', type: 'string' }));
    const destination = join(root, 'built'); assert.ok((await compile(source, destination, previous)).ok);
    assert.equal(verified(join(destination, 'main.ts')).toString(), verified(join(previous, 'main.ts')).toString());
    const validate: unknown = createRequire(import.meta.url)(join(destination, 'schema-validators.cjs')); assert.ok(typeof validate === 'function');
    assert.equal(Reflect.apply(validate, undefined, ['valid']), true); assert.equal(Reflect.apply(validate, undefined, [false]), false);
    await writeFile(join(previous, 'main.ts.js'), 'tampered trusted output'); assert.ok(!(await compile(source, join(root, 'refused'), previous)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('GN-002 vendored TypeScript stays data and removing both output sidecars cannot activate it', async () => {
  const root = await mkdtemp('/tmp/artifacts-'); const path = join(root, 'main.ts');
  try {
    await writeFile(path, "process.stdout.write('must not run');\n"); await buildTree(root, root);
    await writeFile(join(root, 'vendor.ts'), 'enum PublishedAsData { value }'); assert.ok((await verifyTree(root)).ok);
    await rm(`${path}.js`); assert.ok(!(await verifyTree(root)).ok); await rm(`${path}.artifact.json`);
    const result = await execute(path); assert.notEqual(result.code, 0); assert.equal(result.output, '');
    assert.ok((await verifyTree(root)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});
