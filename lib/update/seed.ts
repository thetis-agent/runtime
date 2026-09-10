/** Write an installation's recipe and trusted seed from the release's own reviewed sources, never from invented pins; ADR 0048, GN-002, KS-009. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schemas, failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { catalog } from '@/lib/profile/catalog.ts';
import { materialize } from '@/lib/profile/index.ts';
import { target } from '@/lib/profile/target.ts';
import { validator } from '@/lib/profile/schema.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { writeDeployment } from '@/lib/profile/orchestrate.ts';
import { releaseDigest } from '@/lib/deployment/release.ts';
import type { Layer, Recipe } from '@/lib/profile/types.ts';
import type { Deployment, Target } from '@/lib/deployment/types.ts';
import { readProvider } from './provider-setup.ts';
import type { ProviderSetup } from './provider-setup.ts';

export const seedLimits = { quotaBytes: 536870912, layers: 256 };
/** The example recipe's second account and the placeholder person the installer renames. */
const example = { person: 'alice', dropped: ['bob', 'bob-cli', 'bob-web'], paths: '/var/lib/thetis', cgroup: '/sys/fs/cgroup/thetis' };

export interface Options { release: string; state: string; prefix: string; cgroup: string; operator: string; origin: string; quotaBytes: number; providerConfig?: string; kernelOrigin?: string }

/** Every declared capacity becomes the state volume's real size, because `lib/sandbox-runner` compares it against `statfs`. */
function bounded(value: unknown, quotaBytes: number): unknown {
  if (Array.isArray(value)) return value.map(item => bounded(item, quotaBytes));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'quotaBytes' || key === 'maximumBytes' ? quotaBytes : bounded(item, quotaBytes)]));
}

export async function installedRecipe(options: Options, schemas: Schemas): Promise<Result<Recipe>> {
  const source = join(options.release, 'profiles/examples/two-account.recipe.json');
  let text: string;
  try { text = await readFile(source, 'utf8'); } catch { return failure('io', 'The release does not carry the example recipe the installer starts from.'); }
  const replaced = text
    .split(`${example.paths}/kernel`).join(join(options.state, 'kernel'))
    .split(`${example.paths}/initial`).join(join(options.state, 'initial'))
    .split(`${example.paths}/spaces/`).join(`${join(options.state, 'spaces')}/`)
    .split(example.paths).join(options.state)
    .split(example.cgroup).join(options.cgroup);
  let parsed: unknown;
  try { parsed = JSON.parse(replaced); } catch { return failure('invalid-args', 'The release example recipe is not valid JSON.'); }
  if (!isObject(parsed) || !Array.isArray(parsed.targets) || !isObject(parsed.identity)) return failure('invalid-args', 'The release example recipe has no identity and targets.');
  const kept = parsed.targets.filter(item => isObject(item) && typeof item.id === 'string' && !example.dropped.includes(item.id));
  const renamed: unknown = JSON.parse(JSON.stringify({ ...parsed, targets: kept }).split(example.person).join(options.operator));
  if (!isObject(renamed) || !Array.isArray(renamed.targets) || !isObject(renamed.discovery) || !Array.isArray(renamed.discovery.selection)) return failure('invalid-args', 'The installed recipe lost its targets or discovery selection.');
  const sources = await catalog(options.release); if (!sources.ok) return sources;
  const shared = sources.value.filter(source => source.kind !== 'packages').map(source => source.name);
  const discovery: unknown[] = renamed.discovery.selection;
  renamed.discovery.selection = [...new Set([...discovery, ...shared, 'autoupdate'])];
  const targets: unknown[] = [notice(options, [...shared, 'autoupdate']), ...renamed.targets as unknown[]];
  for (const target of targets) {
    if (isObject(target) && target.id === `${options.operator}-cli` && Array.isArray(target.services)) {
      target.services.push({ id: 'update-status', mount: '/services/update-status' });
    }
  }
  const recipe = bounded({ ...renamed, identity: operatorIdentity(options.operator), targets }, options.quotaBytes);
  const check = await validator<Recipe>(schemas, 'recipe');
  if (!check(recipe)) return failure('invalid-args', 'The installed recipe does not match the recipe contract.');
  if (options.providerConfig) configureProvider(recipe, await readProvider(options.providerConfig, schemas));
  return { ok: true, value: recipe };
}

function configureProvider(recipe: Recipe, provider: ProviderSetup): void {
  const packageName = 'provider-openai-compatible';
  recipe.discovery.selection = [...new Set(recipe.discovery.selection.map(name => name === 'provider-mock' ? packageName : name))];
  for (const target of recipe.targets) {
    if (target.id === 'provider') {
      target.package = packageName;
      target.selection = target.selection.map(name => name === 'provider-mock' ? packageName : name);
      target.profile = { rule: { name: 'daily-model-budget', cost: provider.dailyBudget, requests: 1000, windowMs: 86400000 },
        settings: { endpoint: provider.endpoint, models: [provider.model] } };
    }
    if (target.environment && isObject(target.profile.runtime)) target.profile.runtime.model = provider.model.id;
  }
}

function operatorIdentity(operator: string): object {
  return { people: [{ id: operator, role: 'admin', projects: [], observeOthers: true }],
    bindings: [{ kind: 'password', id: operator, person: operator }], authorities: { password: 'login' } };
}

/** The in-product notice reads the host updater's status file and applies nothing (ADR 0048). */
function notice(options: Options, selection: string[]): object {
  return { quotaBytes: options.quotaBytes, state: join(options.state, 'initial'), profile: {}, id: 'update-status', owner: '', scope: 'deployment',
    package: 'autoupdate', entry: 'service.ts', spawn: 'status', selection,
    mounts: [{ source: join(options.state, 'updates'), path: '/updates', mode: 'ro' }] };
}

/** Publish the release's own reviewed sources as the registry seed target, exactly as KS-009 assembles them. */
export async function seedTarget(options: Options, schemas: Schemas): Promise<Result<Target>> {
  const sources = await catalog(options.release); if (!sources.ok) return sources;
  const layers: Layer[] = [];
  for (const source of sources.value.filter(item => item.kind !== 'packages' || item.name === 'registries')) {
    const reviewed = join(options.state, 'review', source.kind, source.directory);
    await mkdir(join(reviewed, '..'), { recursive: true, mode: 0o700 });
    const hash = await snapshot(source.source, reviewed); if (!hash.ok) return hash;
    const version = source.manifest['version'];
    if (typeof version !== 'string') return failure('invalid-args', `The reviewed source ${source.name} has no version.`);
    layers.push({ ...source, source: reviewed, pin: { name: source.name, version, hash: hash.value, commit: '0'.repeat(40) } });
  }
  if (layers.length > seedLimits.layers) return failure('budget', 'The reviewed source closure exceeds its layer budget.');
  const installed = await materialize(layers, join(options.state, 'seed'), schemas); if (!installed.ok) return installed;
  return target(installed.value, { id: 'registry', quotaBytes: options.quotaBytes, owner: '', scope: 'deployment', state: join(options.state, 'initial'),
    package: 'registries', entry: 'service.ts', profile: { registry: '/registry', cache: '/cache', sources: ['/sources/repository'] }, mounts: [
      { source: join(options.state, 'registry'), path: '/registry', mode: 'rw', maximumBytes: options.quotaBytes },
      { source: join(options.state, 'cache'), path: '/cache', mode: 'rw', maximumBytes: options.quotaBytes },
      { source: options.release, path: '/sources/repository', mode: 'ro' }] }, schemas);
}

export function deployment(options: Options, seed: Target): Deployment {
  return { version: 1, root: join(options.state, 'kernel'), cgroup: options.cgroup, identity: {
    people: [{ id: options.operator, role: 'admin', projects: [], observeOthers: true }],
    bindings: [{ kind: 'password', id: options.operator, person: options.operator }], authorities: { password: 'login' } },
    targets: [seed],
    bootstrap: { recipe: join(options.prefix, 'etc/recipe.json'), registry: 'registry', cache: join(options.state, 'cache'),
      output: join(options.state, 'deployment.json'), profile: join(options.state, 'profile'), discoveryRoot: join(options.state, 'discovery') },
    trusted: { origin: options.kernelOrigin ?? options.origin.replace('https://', 'https://kernel.'), socket: join(options.state, 'kernel/origin.sock'), keyFd: 4, administrator: options.operator,
      baseline: 1, digest: releaseDigest([seed]), releases: [], plans: [] } };
}

export async function writeInstallation(options: Options, schemas: Schemas): Promise<Result<{ recipe: string; seed: string }>> {
  const recipe = await installedRecipe(options, schemas); if (!recipe.ok) return recipe;
  const recipePath = join(options.prefix, 'etc/recipe.json');
  await mkdir(join(options.prefix, 'etc'), { recursive: true, mode: 0o755 });
  await writeFile(recipePath, `${JSON.stringify(recipe.value, null, 2)}\n`, { mode: 0o644 });
  const seed = await seedTarget(options, schemas); if (!seed.ok) return seed;
  const seedPath = join(options.prefix, 'etc/seed.json');
  const written = await writeDeployment(seedPath, deployment(options, seed.value)); if (!written.ok) return written;
  return { ok: true, value: { recipe: recipePath, seed: seedPath } };
}

function options(argv: readonly string[]): Result<Options> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) return failure('invalid-args', 'The seed writer takes only named flags with values.');
    flags.set(flag.slice(2), value);
  }
  const required = ['release', 'state', 'prefix', 'cgroup', 'operator', 'origin', 'quota'];
  const missing = required.find(name => !flags.get(name));
  if (missing !== undefined) return failure('invalid-args', `The seed writer needs --${missing}.`);
  const quota = Number(flags.get('quota'));
  if (!Number.isSafeInteger(quota) || quota <= 0) return failure('invalid-args', 'The seed writer needs a positive --quota in bytes.');
  return { ok: true, value: { release: flags.get('release') ?? '', state: flags.get('state') ?? '', prefix: flags.get('prefix') ?? '',
    cgroup: flags.get('cgroup') ?? '', operator: flags.get('operator') ?? '', origin: flags.get('origin') ?? '', quotaBytes: quota,
    ...flags.has('provider-config') ? { providerConfig: flags.get('provider-config') ?? '' } : {},
    ...flags.has('kernel-origin') ? { kernelOrigin: flags.get('kernel-origin') ?? '' } : {} } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = options(process.argv.slice(2));
  const schemas = new Schemas(); await schemas.load();
  const result = parsed.ok ? await writeInstallation(parsed.value, schemas) : parsed;
  if (result.ok) process.stdout.write(`${JSON.stringify(result.value)}\n`);
  else { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; }
}
