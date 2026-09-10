/** Bind only a canonical private socket path and refuse an existing endpoint; ADR 0009, KS-001. */
import type { Server } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { resolvePath } from '../files/index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
export async function listen(server: Server, path: string): Promise<Result<{ close(): Promise<Result<void>> }>> {
  const canonical = await resolvePath(basename(path), [{ path: dirname(path), mode: 'rw', space: 'kernel origin' }], true); if (!canonical.ok) return canonical;
  const opened = await new Promise<Result<void>>(resolve => {
    server.once('error', () => { resolve(failure('io', 'The kernel origin endpoint could not be bound.')); });
    server.listen(canonical.value, () => { resolve({ ok: true, value: undefined }); });
  }); if (!opened.ok) return opened;
  await chmod(canonical.value, 0o600);
  return { ok: true, value: { close: async () => {
    server.closeAllConnections(); const closed = await new Promise<Result<void>>(resolve => { server.close(error => { resolve(error ? failure('io', 'The kernel origin endpoint could not close.') : { ok: true, value: undefined }); }); });
    try { await unlink(canonical.value); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return failure('io', 'The kernel origin endpoint could not be removed.'); }
    return closed;
  } } };
}
