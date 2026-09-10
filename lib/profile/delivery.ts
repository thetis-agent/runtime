/** Keep profile assembly inside the registry sandbox and return only verified cache paths; GN-002, ADR 0017. */
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materialize } from './index.ts';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Registry } from '@/lib/registry/index.ts';
import type { Selection } from '@/contracts/registry/types.ts';
import type { Install, Layer } from './types.ts';
export async function assemble(registry: Registry, cache: string, selections: readonly Selection[], schemas: Schemas): Promise<Result<Install>> {
  const layers: Layer[] = [];
  for (const selected of selections) {
    const path = join(cache, selected.pin.commit); let hash = await snapshot(path);
    if (!hash.ok) { const fetched = await registry.fetch(selected.pin, path); if (!fetched.ok) return fetched; hash = await snapshot(path); }
    if (!hash.ok || hash.value !== selected.pin.hash) return failure('hash-mismatch', 'The selected cached package does not match its pin.');
    const version = await registry.inspect(selected.pin.name, selected.pin.version); if (!version.ok) return version;
    if (version.value.pin.commit !== selected.pin.commit || version.value.pin.hash !== selected.pin.hash) return failure('hash-mismatch', 'The selected immutable version does not match its pin.');
    layers.push({ ...selected, source: path });
  }
  const profiles = join(cache, 'profiles'); await mkdir(profiles, { recursive: true, mode: 0o700 });
  const pending = join(profiles, randomUUID()); const installed = await materialize(layers, pending, schemas, true); if (!installed.ok) return installed;
  const target = join(profiles, installed.value.hash.slice(7));
  try {
    const existing = await snapshot(target);
    if (existing.ok) {
      if (existing.value !== installed.value.hash) return failure('hash-mismatch', 'The retained profile cache does not match its digest.');
    } else await rename(pending, target);
    return { ok: true, value: { ...installed.value, source: target, aliases: installed.value.aliases.map(alias => ({ ...alias, source: join(target, alias.source.slice(pending.length + 1)) })) } };
  } finally { await rm(pending, { recursive: true, force: true }); }
}
