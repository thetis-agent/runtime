/** Validate recorded formats only within an isolated state root; ADR 0031, GN-002. */
import { readBounded } from './read-bounded.ts';
import { resolvePath } from './index.ts';
import { failure } from '../schema/index.ts';
import type { Result, Schemas } from '../schema/index.ts';
export async function formats(state: string, declarations: readonly { path: string; schema: Record<string, unknown> }[], schemas: Schemas, bytes: number): Promise<Result<void>> {
  for (const format of declarations) {
    const path = await resolvePath(format.path, [{ path: state, mode: 'ro', space: 'state' }]); if (!path.ok) return path;
    const value = await readBounded(path.value, bytes); if (!value.ok) return value;
    try {
      const document: unknown = JSON.parse(value.value.toString('utf8'));
      if (!schemas.arguments(format.schema, document)) return failure('invalid-args', `${format.path} does not match its declared state format.`);
    } catch { return failure('invalid-args', `${format.path} is not a valid state format document.`); }
  }
  return { ok: true, value: undefined };
}
