/** Keep even development tests inside the mandatory namespace boundary; ADR 0012 §8. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { namespace, seal } from '@/lib/sandbox-runner/namespace.ts';
import { delegate } from '@/lib/sandbox-runner/cgroup.ts';
import { packagesRoot } from '@/lib/profile/packages-root.ts';
import { sourceMounts, workspace } from '@/scripts/workspace.ts';
import { sourceFlags } from '@/lib/artifacts/index.ts';
import { coverageFlags, coverageLimits, prepareCoverage, writeCoverage } from '@/scripts/coverage.ts';
// Eight persistent sandboxed targets (the two-account recipe with its web surface) exhaust 128 tasks as the seventh starts.
const supervisor = { memoryMiB: 2048, tasks: 256, cpuPercent: 100 };

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.runtime', '.registry', '.agents', '.codex', 'docs'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.name.endsWith('.test.ts')) output.push(path);
  }
  return output.sort();
}

if (!process.argv.includes('--delegated')) {
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '-p', 'Delegate=yes', '-p', `MemoryMax=${String(supervisor.memoryMiB)}M`, '-p', `TasksMax=${String(supervisor.tasks)}`, '-p', `CPUQuota=${String(supervisor.cpuPercent)}%`, process.execPath, ...sourceFlags(), new URL(import.meta.url).pathname, '--delegated', ...process.argv.slice(2)], { stdio: 'inherit' });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const control = await delegate();
  if (!control.ok) { process.stderr.write(`${control.error.message}\n`); process.exitCode = 1; }
  else await run(control.value);
}

// OpenSSH tools fatal on getpwuid before doing any work, so release-signature tests need one synthetic account inside the sealed namespace (ADR 0048).
async function accounts(): Promise<string> {
  const directory = await mkdtemp('/tmp/thetis-accounts-'); const path = join(directory, 'passwd');
  await writeFile(path, `thetis:x:${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}::/tmp:/bin/sh\n`);
  return path;
}

async function run(control: string): Promise<void> {
  const root = await realpath(new URL('..', import.meta.url));
  const runtime = dirname(dirname(process.execPath));
  const registry = await realpath(packagesRoot(root));
  const requested = process.argv.slice(2).filter(argument => argument !== '--delegated');
  const at = requested.indexOf('--coverage'); let coverage: string | undefined;
  if (at !== -1) {
    const path = requested[at + 1]; if (!path || path.startsWith('--')) throw new Error('--coverage requires an output directory.');
    coverage = resolve(path); requested.splice(at, 2);
    if (requested.includes('--coverage')) throw new Error('--coverage may be supplied only once.');
    await prepareCoverage(coverage);
  }
  const tests = [...(await files(root)).map(path => join(workspace, relative(root, path))),
    ...(registry === join(root, 'packages') ? [] : (await files(registry)).map(path => join(workspace, 'packages', relative(registry, path))))]
    .filter(path => !requested.length || requested.some(prefix => relative(workspace, path).startsWith(prefix))).sort();
  if (!tests.length) throw new Error('No tests match the requested workspace paths.');
  const passwd = await accounts();
  const args = [...namespace(runtime, 67108864), '--size', '67108864', '--tmpfs', '/packages', '--size', '536870912', '--tmpfs', '/assembly',
    '--size', '536870912', '--tmpfs', '/installation', '--size', '1073741824', '--tmpfs', '/d',
    ...coverage ? ['--size', String(coverageLimits.rawBytes), '--tmpfs', '/coverage', '--setenv', 'TMPDIR', '/coverage'] : [],
    '--dev-bind', '/dev/net/tun', '/dev/net/tun', '--dir', '/etc', '--dir', '/run', '--ro-bind', passwd, '/etc/passwd', ...await sourceMounts(root), '--bind', control, '/cgroup', '--chdir', workspace,
    ...seal,
    '--', '/runtime/bin/node', '--import', `${workspace}/lib/artifacts/source.mjs`, '--test', '--test-concurrency=1', ...coverage ? coverageFlags() : [], ...tests
  ];
  const child = spawn('bwrap', args, { stdio: ['inherit', coverage ? 'pipe' : 'inherit', 'inherit'], env: { PATH: '/usr/bin:/bin' } });
  const closed = new Promise<number>(resolve => { child.once('error', error => { process.stderr.write(`${error.message}\n`); resolve(1); }); child.once('close', code => { resolve(code ?? 1); }); });
  let reportStatus = 0;
  try {
    if (coverage && child.stdout) await writeCoverage(child.stdout, coverage);
  } catch (error) { process.stderr.write(`${String(error)}\n`); reportStatus = 1; child.kill('SIGKILL'); }
  finally { process.exitCode = Math.max(await closed, reportStatus); await rm(dirname(passwd), { recursive: true, force: true }); }
}
