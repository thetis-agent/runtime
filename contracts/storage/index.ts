/** Keep storage mechanics independent of identity, encryption and journal provenance; ADR 0040, ST-001–007. */
import type { AppendLimits, Error, Limits } from './types.ts';
export type { AppendLimits, Limits } from './types.ts';
export type Result<T, C extends Error['code'] = Error['code']> = { ok: true; value: T } | { ok: false; error: { code: C; message: string } };

export interface Storage {
  has(key: string): boolean;
  get(key: string): Promise<Result<Uint8Array>>;
  put(key: string, value: Uint8Array): Promise<Result<void, 'invalid-args' | 'budget' | 'io'>>;
}
export interface AppendLog {
  append(value: Uint8Array, maximum: number): Promise<Result<void, 'budget' | 'io'>>;
  close(): Promise<void>;
}
export interface StorageProvider {
  open(root: string, limits: Limits): Promise<Result<Storage, 'invalid-args' | 'budget' | 'io'>>;
  journal(path: string, limits: AppendLimits): Promise<Result<AppendLog, 'io'>>;
}
