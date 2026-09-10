/** Keep root imports bound to relocated revisions and verified worker graphs; ADR 0047, GN-002. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTree } from './build.ts';
import { flags, sourceFlags } from './index.ts';

async function execute(entry: string, artifacts: boolean): Promise<{ code: number | null; output: string; error: string }> {
  const child = spawn(process.execPath, [...(artifacts ? flags() : sourceFlags()), entry], { cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000); let output = ''; let error = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); if (error.length > 16384) child.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output, error }); });
  });
}

async function fixture(root: string): Promise<void> {
  for (const [scope, name] of [['', 'thetis'], ['kernel', '@thetis/kernel'], ['lib/value', '@thetis/lib-value'], ['packages/example', 'example'], ['test', '@thetis/test']] satisfies [string, string][]) {
    await mkdir(join(root, scope), { recursive: true });
    await writeFile(join(root, scope, 'package.json'), JSON.stringify({ name, type: 'module' }));
  }
  await mkdir(join(root, 'kernel/nested')); await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'lib/value/index.ts'), "export const value: string = 'original';\n");
  await writeFile(join(root, 'lib/value/settings.json'), '{"enabled":true}');
  await writeFile(join(root, 'kernel/nested/worker.ts'), "import {parentPort} from 'node:worker_threads'; import {value} from '@/lib/value/index.ts'; parentPort?.postMessage(value);\n");
  await writeFile(join(root, 'kernel/exports.ts'), "export {value} from '@/lib/value/index.ts';\n");
  await writeFile(join(root, 'kernel/nested/main.ts'), "import {Worker} from 'node:worker_threads'; import settings from '@/lib/value/settings.json' with {type:'json'}; const {value} = await import('@/kernel/exports.ts'); const worker = new Worker(new URL('./worker.ts', import.meta.url)); worker.once('message', message => process.stdout.write(JSON.stringify([value,message,settings.enabled])));\n");
  for (const scope of ['packages/example', 'test', 'scripts']) {
    await writeFile(join(root, scope, 'main.ts'), "import '@/kernel/nested/main.ts';\n");
  }
}

await test('ADR 0047 source and verified workers resolve aliases in their own relocated installation', async () => {
  const temporary = await mkdtemp('/tmp/root-imports-'); const original = join(temporary, 'original');
  try {
    await fixture(original);
    for (const name of ['relocated', 'kernel', 'lib/runtime']) {
      const relocated = join(temporary, name); await cp(original, relocated, { recursive: true });
      await writeFile(join(relocated, 'lib/value/index.ts'), "export const value: string = 'relocated';\n");
      await buildTree(relocated, relocated);
      for (const artifacts of [false, true]) for (const scope of ['kernel/nested', 'packages/example', 'test', 'scripts']) {
        const result = await execute(join(relocated, scope, 'main.ts'), artifacts);
        assert.equal(result.code, 0, result.error); assert.deepEqual(JSON.parse(result.output), ['relocated', 'relocated', true]);
      }
      await writeFile(join(relocated, 'lib/value/index.ts.js'), "export const value = 'forged';\n");
      const refused = await execute(join(relocated, 'kernel/nested/main.ts'), true);
      assert.notEqual(refused.code, 0); assert.equal(refused.output, ''); assert.match(refused.error, /hash-mismatch/u);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

await test('ADR 0047 traversal and URL escapes cannot leave the alias root', async () => {
  const root = await mkdtemp('/tmp/root-imports-');
  try {
    await fixture(root);
    for (const source of ['@/../outside.ts', '@/lib/%2e%2e/outside.ts', '@/lib/value/index.ts?other', '@/lib//value/index.ts']) {
      const entry = join(root, 'kernel/nested/refused.ts'); await writeFile(entry, `import '${source}';\n`);
      const result = await execute(entry, false); assert.notEqual(result.code, 0); assert.equal(result.output, ''); assert.match(result.error, /outside-roots/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
