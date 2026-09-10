/** Map only the configured service cache into canonical host sources before kernel verification; GN-002. */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import { validator } from './schema.ts';
import type { Install } from './types.ts';
export async function cache(input: unknown, host: string, schemas: Schemas): Promise<Result<Install>> {
  if (!(await validator<Install>(schemas, 'install'))(input)) return failure('invalid-args', 'The service installation description is invalid.');
  try {
    const root = await realpath(host); const mapped = new Map<string, string>();
    for (const path of new Set([input.source, ...input.aliases.map(alias => alias.source), ...input.layers.map(layer => layer.source)])) {
      if (!path.startsWith('/cache/')) return failure('outside-roots', 'The service path is outside its fixed cache.');
      const pathInCache = join(root, path.slice('/cache/'.length)); const canonical = await realpath(pathInCache);
      if (canonical !== pathInCache || !canonical.startsWith(`${root}/`)) return failure('outside-roots', 'The service installation is outside the configured canonical cache.');
      mapped.set(path, canonical);
    }
    const source = (path: string): string => { const value = mapped.get(path); if (!value) throw new Error('The validated cache map lost a source.'); return value; };
    return { ok: true, value: { ...input, source: source(input.source), aliases: input.aliases.map(alias => ({ ...alias, source: source(alias.source) })), layers: input.layers.map(layer => ({ ...layer, source: source(layer.source) })) } };
  } catch { return failure('outside-roots', 'The service installation is outside the configured canonical cache.'); }
}
