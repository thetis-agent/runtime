/** Verify bootstrap refusal, retained configuration and removal against signed releases; ADR 0048, implementation note 0052, GN-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import { configuration } from '@/lib/deployment/index.ts';
import { readInstall } from '@/lib/update/install.ts';
import { command, install, places, flags, discard, password, remote, apiKey } from './installer-fixture.ts';
import { Secrets } from '@/kernel/secrets/index.ts';
const units = fileURLToPath(new URL('../units/', import.meta.url));

async function publicExecutables(prefix: string): Promise<void> {
  assert.ok((await stat(join(prefix, 'bin/thetis'))).mode & 0o111);
  for (const path of ['bin', 'node', 'node/current', 'node/current/bin', 'node/current/bin/node']) {
    assert.equal((await stat(join(prefix, path))).mode & 0o555, 0o555, `The service account cannot traverse or execute ${path}.`);
  }
}

await test('the installer refuses an update policy no record has accepted, and a state root that would break a target endpoint', async () => {
  const refused = await install(['--auto-update', 'fixes', '--origin', 'https://thetis.test', '--dry-run'], false);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /ADR 0049/u);
  const long = await install(['--state', '/var/lib/thetis-deployment', '--origin', 'https://thetis.test', '--dry-run'], false);
  assert.equal(long.status, 1); assert.match(long.stderr, /socket path limit/u);
  const unknown = await install(['--nonsense'], false);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Unknown flag/u);
  const help = await install(['--help'], false);
  assert.equal(help.status, 0); assert.match(help.stdout, /--password-fd/u);
});

await test('--dry-run prints the privileged steps in a stable order and writes nothing', async () => {
  const root = await mkdtemp('/tmp/dry-');
  try {
    // The golden output names the documented default paths; a dry run writes nothing, so naming them is safe.
    const run = await install(['--prefix', '/opt/thetis', '--state', '/var/lib/thetis', '--origin', 'https://thetis.test', '--operator', 'op', '--dry-run'], false);
    assert.equal(run.status, 0, run.stderr);
    const golden = await readFile(new URL('./fixtures/installer-dry-run.txt', import.meta.url), 'utf8');
    assert.equal(run.stdout, golden);
    assert.match(run.stdout, /^write accounts\.json \(1 account\)$/mu);
    assert.doesNotMatch(run.stdout, /\bop\b/u);
    assert.equal(await stat('/opt/thetis').then(() => true, () => false), false, 'A dry run created the prefix.');
    assert.equal((await readdir(root)).length, 0, 'A dry run created a file under the temporary root.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('every embedded unit template is byte-identical to its reviewable copy', async () => {
  for (const name of ['thetis.service', 'thetis-update.service', 'thetis-update.timer', 'state.mount']) {
    const printed = await install(['--print-unit', name], false);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout, await readFile(join(units, name), 'utf8'), `${name} differs from the text the installer installs.`);
  }
  const absent = await install(['--print-unit', 'nonsense.service'], false);
  assert.equal(absent.status, 1); assert.match(absent.stderr, /no embedded unit/u);
});

await test('ADR 0048 a missing or forged signature stops the install before any file exists under the prefix', async () => {
  const at = await places('v0.1.0');
  try {
    const base = flags(at);
    const signature = join(at.fixture.dir, 'SHA256SUMS.sig');
    await rm(signature);
    const unsigned = await install(base);
    assert.equal(unsigned.status, 1); assert.match(unsigned.stderr, /SHA256SUMS\.sig is missing/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false, 'A refused install left a file under the prefix.');
    await writeFile(signature, 'not a signature\n');
    const forged = await install(base);
    assert.equal(forged.status, 1); assert.match(forged.stderr, /signature/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
  } finally { await discard(at); }
});

await test('ADR 0048 an altered asset is refused by the signed checksums, and a tag that resolves elsewhere by its provenance', async () => {
  const at = await places('v0.1.0');
  try {
    const asset = join(at.fixture.dir, 'registry.json');
    const original = await readFile(asset, 'utf8');
    await writeFile(asset, `${original} `);
    const altered = await install(flags(at));
    assert.equal(altered.status, 1); assert.match(altered.stderr, /checksums/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
    await writeFile(asset, original);
    const other = await remote(join(at.roots[1] ?? '', 'other.git'), 'a different history');
    const elsewhere = await install(flags(at, other.path));
    assert.equal(elsewhere.status, 1); assert.match(elsewhere.stderr, /different commit than tag v0\.1\.0/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
  } finally { await discard(at); }
});

await test('ADR 0048 a fresh install lays out a supervised deployment whose seed, accounts and recorded choices validate', async () => {
  const at = await places('v0.1.0'); const schemas = new Schemas(); await schemas.load();
  try {
    const prefix = at.prefix; const state = at.state;
    const run = await install(flags(at));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, new RegExp(password, 'u'));
    assert.match(run.stdout, /sign in at https:\/\/thetis\.test\/login as op$/mu);

    const seed = await configuration(join(prefix, 'etc/seed.json'), schemas);
    assert.ok(seed.ok, JSON.stringify(seed));
    const trusted = seed.value.trusted; assert.ok(trusted, 'The installed seed has no trusted kernel block.');
    assert.equal(trusted.keyFd, 4); assert.equal(trusted.administrator, 'op');
    assert.equal(trusted.origin, 'https://kernel.thetis.test');
    assert.equal(seed.value.root, join(state, 'kernel'));
    assert.equal(seed.value.targets.length, 1); assert.equal(seed.value.targets[0]?.id, 'registry');
    const bootstrap = seed.value.bootstrap; assert.ok(bootstrap, 'The installed seed has no bootstrap block.');
    assert.equal(bootstrap.recipe, join(prefix, 'etc/recipe.json'));

    const recorded = await readInstall(prefix, schemas); assert.ok(recorded.ok, JSON.stringify(recorded));
    assert.equal(recorded.value.operator, 'op'); assert.equal(recorded.value.policy, 'none'); assert.equal(recorded.value.release, 'v0.1.0');
    assert.doesNotMatch(await readFile(join(prefix, 'etc/install.json'), 'utf8'), new RegExp(password, 'u'));
    assert.doesNotMatch(await readFile(join(prefix, 'etc/seed.json'), 'utf8'), new RegExp(password, 'u'));

    const accountsRaw: unknown = JSON.parse(await readFile(join(state, 'login-state/accounts.json'), 'utf8'));
    const accountsSchema: unknown = JSON.parse(await readFile(join(prefix, 'current/packages/gateway-login/schema.json'), 'utf8'));
    assert.ok(typeof accountsSchema === 'object' && accountsSchema !== null);
    const check = schemas.compile<{ version: 1; accounts: { id: string }[] }>({ ...accountsSchema });
    assert.ok(check(accountsRaw), 'accounts.json does not validate against the login authority contract.');
    assert.equal(accountsRaw.accounts.length, 1); assert.equal(accountsRaw.accounts[0]?.id, 'op');

    const recipe: unknown = JSON.parse(await readFile(join(prefix, 'etc/recipe.json'), 'utf8'));
    assert.ok(isObject(recipe) && Array.isArray(recipe['targets']));
    const listed: unknown[] = recipe['targets'];
    const ids = listed.flatMap(item => isObject(item) && typeof item['id'] === 'string' ? [item['id']] : []);
    assert.deepEqual(ids.filter(id => id.startsWith('bob')), []);
    assert.ok(ids.includes('op') && ids.includes('op-cli') && ids.includes('login') && ids.includes('update-status'), ids.join(','));

    await publicExecutables(prefix);
    assert.ok((await stat(join(prefix, 'etc/allowed_signers'))).isFile());
    assert.ok((await stat(join(state, 'g'))).isDirectory());
    assert.equal((await stat(join(state, 'login-state/accounts.json'))).mode & 0o777, 0o600);

    const again = await install(flags(at));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Thetis v0\.1\.0 is already installed at /mu);

    const status = await command(join(prefix, 'bin/thetis'), ['status'], false);
    assert.equal(status.status, 1, 'A stopped installation must not pretend that thetis status succeeded.');
    assert.match(status.stderr, /not accepting connections/u);
    const planned = await install(['--prefix', prefix, '--uninstall', '--dry-run']);
    assert.equal(planned.status, 0, planned.stderr); assert.ok((await stat(prefix)).isDirectory());
    const removed = await install(['--prefix', prefix, '--uninstall']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await stat(prefix).then(() => true, () => false), false, '--uninstall left the prefix in place.');
    assert.ok((await stat(join(state, 'login-state/accounts.json'))).isFile(), '--uninstall removed state without --purge-state.');
    assert.equal((await stat(join(state, 'retained-master.key'))).mode & 0o777, 0o600);
  } finally { await discard(at); }
});

await test('a real provider is configured before bootstrap and its descriptor-only key is encrypted, never saved in settings', async () => {
  const at = await places('v0.1.0');
  try {
    const config = join(at.published, 'provider.json');
    await writeFile(config, JSON.stringify({ endpoint: 'https://openrouter.ai/api/v1/chat/completions', dailyBudget: 1,
      model: { id: 'fixture/model', contextWindow: 2048, maxOutput: 128, tools: true, images: false, seed: false, cache: 'implicit', price: { in: 2, out: 10 } } }));
    const result = await install([...flags(at).filter(flag => flag !== '--demo'), '--provider-config', config, '--api-key-fd', '4']);
    assert.equal(result.status, 0, result.stderr);
    const recipe = await readFile(join(at.prefix, 'etc/recipe.json'), 'utf8');
    assert.match(recipe, /provider-openai-compatible/u); assert.doesNotMatch(recipe, /provider-mock/u);
    assert.match(recipe, /fixture\/model/u);
    assert.ok(!`${recipe}${result.stdout}${result.stderr}`.includes(apiKey));
    const master = await readFile(join(at.prefix, 'etc/master.key'));
    const store = await Secrets.open(join(at.state, 'kernel/sealed'), master); assert.ok(store.ok);
    assert.ok(store.value.register('fixture-provider', 'deployment', ['llm-key']).ok);
    const stored = await store.value.deliver('fixture-provider', 'llm-key');
    assert.ok(stored.ok, JSON.stringify(stored)); assert.equal(Buffer.from(stored.value).toString('utf8'), apiKey);
    master.fill(0);
  } finally { await discard(at); }
});

await test('implementation note 0052 a tampered Node archive is refused before the installer writes its prefix', async () => {
  const at = await places('v0.1.0');
  try {
    const directory = fileURLToPath(`${at.fixture.nodeUrl}/${process.version}`);
    const archives = await readdir(directory); const archive = archives.find(name => name.endsWith('.tar.xz'));
    assert.ok(archive); const path = join(directory, archive); const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('tampered')]));
    const refused = await install(flags(at));
    assert.equal(refused.status, 1); assert.match(refused.stderr, /Node archive does not match/u);
    assert.equal(await stat(at.prefix).then(() => true, () => false), false);
  } finally { await discard(at); }
});
