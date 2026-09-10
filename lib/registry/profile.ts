/** Pin resolution before installation and reject reordered or mismatched identities; proposal §5–6. */
import { resolve } from '@/lib/semver-match/index.ts';
import type { Provision, Package } from '@/lib/semver-match/index.ts';
import { failure } from '@/lib/result/index.ts';
import type { Result } from '@/lib/result/index.ts';
import type { Registry, Lock, Pin } from './index.ts';

export async function lock(registry: Registry, requested: readonly Pin[], facts: readonly Provision[] = []): Promise<Result<Lock>> {
  if (requested.length > 256) return failure('budget', 'The profile exceeds its package limit.');
  const packages: Package[] = []; const pins = new Map<string, Pin>();
  for (const pin of requested) {
    if (pins.has(pin.name)) return failure('conflict', 'The profile contains two pins for one package.');
    const published = await registry.inspect(pin.name, pin.version); if (!published.ok) return published;
    if (published.value.pin.commit !== pin.commit || published.value.pin.hash !== pin.hash) return failure('hash-mismatch', 'The profile pin does not match the immutable version.');
    const manifest = await registry.manifest(pin); if (!manifest.ok) return manifest;
    packages.push({ name: pin.name, version: pin.version, requires: manifest.value.requires, provides: manifest.value.provides, scope: manifest.value.envelope.spawn.scope });
    pins.set(pin.name, pin);
  }
  const resolved = resolve(packages, facts); if (!resolved.ok) return resolved;
  const ordered: Pin[] = [];
  for (const pkg of resolved.value) { const pin = pins.get(pkg.name); if (!pin) throw new Error('Resolution lost an immutable pin.'); ordered.push(structuredClone(pin)); }
  return { ok: true, value: { version: 1, pins: ordered } };
}
