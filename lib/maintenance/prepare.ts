/** Install every kernel code pin beside the old binary and migrate only a private store copy; ADR 0012 §6. */
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { snapshot } from '@/lib/snapshots/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Deployment } from '@/lib/deployment/types.ts';

export interface Revision { pins: Readonly<Record<string, { source: string; hash: string }>>; entry: string; configuration: Deployment; release?: string }
export interface Prepared { root: string; entry: string; state: string; configuration: string; endpoint: string; hash: string }
export type Capture = (source: string, destination: string) => Promise<Result<string>>;
export const prepareLimits = { pins: 256, configurationBytes: 1048576 };
const inside = (path: string): boolean => path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);

/** A generation's private store may sit in a short sibling root: nesting it under the run workspace exceeds the 107-byte unix socket path for any target endpoint (ADR 0050). */
export async function prepare(root: string, sourceState: string, revision: Revision, capture: Capture, stateRoot?: string): Promise<Result<Prepared>> {
  if (!Object.keys(revision.pins).length || Object.keys(revision.pins).length > prepareLimits.pins || !inside(revision.entry)) return failure('invalid-args', 'The kernel maintenance code pins or entry are invalid.');
  try {
    await mkdir(join(root, 'code'), { recursive: true, mode: 0o700 });
    const code = await realpath(join(root, 'code'));
    for (const [path, pin] of Object.entries(revision.pins)) {
      const destination = join(code, path);
      if (!inside(relative(code, destination))) return failure('outside-roots', 'The kernel code pin escapes its private installation.');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const copied = await snapshot(pin.source, destination); if (!copied.ok) return copied;
      if (copied.value !== pin.hash) return failure('hash-mismatch', 'The new kernel code does not match its authorized pin.');
    }
    const entry = await realpath(join(code, revision.entry));
    if (!inside(relative(code, entry))) return failure('outside-roots', 'The kernel entry escapes its code installation.');
    const state = stateRoot ?? join(root, 'state'); const copied = await capture(sourceState, state); if (!copied.ok) return copied;
    const config = { ...structuredClone(revision.configuration), root: state };
    const bytes = Buffer.from(`${JSON.stringify(config)}\n`); if (bytes.length > prepareLimits.configurationBytes) return failure('budget', 'The kernel maintenance configuration exceeds its byte limit.');
    const configuration = join(root, 'configuration.json'); await writeFile(configuration, bytes, { mode: 0o600 });
    return { ok: true, value: { root, entry, state, configuration, endpoint: join(root, 'kernel.sock'), hash: copied.value } };
  } catch { return failure('io', 'The new kernel code or private store could not be installed.'); }
}
