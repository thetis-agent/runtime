/** Use the reviewed file backend by default without loading person-selected code in the kernel; ADR 0040. */
import type { StorageProvider } from '@/contracts/storage/index.ts';
import { Files } from './files.ts';
import { Durable } from '@/lib/ndjson/durable.ts';
export type { Storage, StorageProvider, AppendLog, Limits } from '@/contracts/storage/index.ts';
export const defaults = Object.freeze({ entries: 4096, valueBytes: 65536, bytes: 67108864 });
export const storage: StorageProvider = Object.freeze<StorageProvider>({
  open: (root, limits) => Files.open(root, limits),
  journal: (path, limits) => Durable.open(path, limits)
});
