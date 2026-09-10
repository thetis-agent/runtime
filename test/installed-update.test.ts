/** Exercise the shipped launcher against a real installed deployment through update, undo and restart; implementation note 0052, GN-007. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '@/lib/registry/git.ts';
import { ask, report } from '@/lib/update/control.ts';
import { buildRelease } from './release-fixture.ts';
import { command, install, places, flags, discard, password } from './installer-fixture.ts';
import type { Places } from './installer-fixture.ts';
import { login, publicSocket } from '@/lib/update/login.ts';
import { webClient, httpGet } from './web-client.ts';

const limits = { outputBytes: 262144, startupMs: 120000, shutdownMs: 90000 };

function supervisor(at: Places): { closed: Promise<number>; output(): string; kill(): void } {
  const child = spawn(join(at.prefix, 'node/current/bin/node'), ['--max-old-space-size=32', '--max-semi-space-size=1',
    '--no-experimental-strip-types', '--import', join(at.prefix, 'current/lib/artifacts/register.mjs'),
    join(at.prefix, 'current/kernel/supervisor-main.ts'), join(at.prefix, 'etc/seed.json'), '--release', join(at.prefix, 'current'),
    '--state', at.state, '--credential', join(at.prefix, 'etc/master.key'), '--installation', at.prefix],
  { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => { if (output.length < limits.outputBytes) output += chunk.toString('utf8'); else child.kill('SIGKILL'); });
  const closed = new Promise<number>(resolve => { child.once('error', () => { resolve(1); }); child.once('close', code => { resolve(code ?? 1); }); });
  return { closed, output: () => output, kill: () => { child.kill('SIGKILL'); } };
}

async function ready(at: Places, running: ReturnType<typeof supervisor>): Promise<void> {
  const deadline = Date.now() + limits.startupMs;
  while (Date.now() < deadline) {
    if ((await report(join(at.state, 'supervisor.sock'))).ok) return;
    const stopped = await Promise.race([running.closed, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
    assert.equal(stopped, undefined, running.output());
  }
  assert.fail(`The installed supervisor did not become ready: ${running.output()}`);
}

async function stop(at: Places, running: ReturnType<typeof supervisor>): Promise<void> {
  await ask(join(at.state, 'supervisor.sock'), 'stop');
  const timer = setTimeout(() => { running.kill(); }, limits.shutdownMs);
  try { assert.equal(await running.closed, 0, running.output()); } finally { clearTimeout(timer); }
}

async function publish(at: Places, tag: string): Promise<void> {
  await buildRelease(join(at.published, tag), { tag, commit: at.fixture.commit, nodeArchive: true });
  const annotated = await git(at.remote, ['mktag'], Buffer.from(`object ${at.fixture.commit}\ntype commit\ntag ${tag}\ntagger release <release@thetis-agent> 0 +0000\n\n${tag}\n`));
  assert.ok(annotated.ok, JSON.stringify(annotated));
  assert.ok((await git(at.remote, ['update-ref', `refs/tags/${tag}`, annotated.value.toString('utf8').trim()])).ok);
}

async function browserChat(at: Places): Promise<void> {
  const web = publicSocket(join(at.state, 'live'), 'op-web');
  const signedOut = await httpGet(web, '/', { accept: 'text/html', prefix: '/op' });
  assert.equal(signedOut.headers.location, '/login?next=%2Fop%2F');
  const session = await login(publicSocket(join(at.state, 'live'), 'login'), 'op', password); assert.ok(session.ok);
  const cookie = `thetis_session=${session.value}`;
  for (const path of ['/', '/app.js', '/app.css', '/theme.css']) assert.equal((await httpGet(web, path, { cookie })).status, 200, path);
  const client = await webClient(web, { cookie });
  try {
    await client.send({ type: 'new' }); const opened = await client.next();
    assert.equal(opened.type, 'opened'); assert.equal(typeof opened.session, 'string');
    await client.send({ type: 'send', id: opened.session, text: 'Hello from the installed browser' });
    let text = ''; let finished = false; let accepted = false;
    for (let count = 0; count < 128 && (!finished || !accepted); count++) {
      const frame = await client.next(); assert.notEqual(frame.type, 'error', JSON.stringify(frame));
      if (frame.kind === 'delta') text += String(frame.text);
      if (frame.kind === 'turn-finished') { finished = true; assert.equal(frame.stopped_by, 'answer'); }
      accepted ||= frame.type === 'accepted';
    }
    assert.ok(finished && accepted && text.length > 0, 'The installed browser did not receive a completed answer.');
  } finally { client.close(); }
}

await test('GN-007 the installed thetis command checks, applies and undoes signed releases, then restarts on its retained store', async () => {
  const at = await places('v0.1.0'); let running: ReturnType<typeof supervisor> | undefined;
  const thetis = (...args: string[]) => command(join(at.prefix, 'bin/thetis'), args);
  try {
    const installed = await install(flags(at)); assert.equal(installed.status, 0, installed.stderr);
    running = supervisor(at); await ready(at, running);
    const initial = await thetis('status'); assert.equal(initial.status, 0, initial.stderr);
    assert.match(initial.stdout, /state LIVE generation 1/u); assert.match(initial.stdout, /\/live\/targets\//u);
    await browserChat(at);
    const chat = await thetis('chat', '--message', 'Hello from the installed CLI');
    assert.equal(chat.status, 0, chat.stderr); assert.match(chat.stdout, /Hello\./u); assert.match(chat.stdout, /Conversation:/u);
    await publish(at, 'v0.1.1');
    const checked = await thetis('update', '--check'); assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /v0\.1\.1 is available and verified/u);
    const repeated = await thetis('update', '--check'); assert.equal(repeated.status, 0, repeated.stderr);
    const applied = await thetis('update', '--apply', '--password-fd', '3'); assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /generation 2/u);
    const changed = await thetis('status'); assert.equal(changed.status, 0, changed.stderr); assert.match(changed.stdout, /releases\/v0\.1\.1/u);
    const undone = await thetis('undo', '--password-fd', '3'); assert.equal(undone.status, 0, undone.stderr); assert.match(undone.stdout, /generation 3/u);
    await stop(at, running); running = undefined;
    running = supervisor(at); await ready(at, running);
    const restored = await thetis('status'); assert.equal(restored.status, 0, restored.stderr); assert.match(restored.stdout, /state LIVE generation 4/u);
    await browserChat(at);
    const pruned = await thetis('prune-releases'); assert.equal(pruned.status, 0, pruned.stderr);
    const rows = await readFile(join(at.state, 'supervisor/observed.jsonl'), 'utf8');
    assert.match(rows, /"event":"undo"/u); assert.doesNotMatch(rows, new RegExp(password, 'u'));
    assert.doesNotMatch(`${installed.stdout}${applied.stdout}${running.output()}`, new RegExp(password, 'u'));
    await stop(at, running); running = undefined;
    const removed = await install(['--prefix', at.prefix, '--uninstall', '--purge-state']); assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
    assert.equal(await stat(at.state).then(() => true, () => false), false);
  } finally {
    if (running) { await ask(join(at.state, 'supervisor.sock'), 'stop'); running.kill(); await running.closed; }
    await discard(at);
  }
});
