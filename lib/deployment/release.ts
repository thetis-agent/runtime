/** Bind a reviewed release to its complete configured target document; ADR 0018, KS-015. */
import { createHash } from 'node:crypto';
import { isObject } from '../schema/index.ts';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function releaseDigest(targets: readonly { readonly id: string }[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical([...targets].sort((a, b) => a.id.localeCompare(b.id))))).digest('hex')}`;
}
