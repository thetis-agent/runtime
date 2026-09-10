/** Resolve generation switches through a scoped directory mount; KS-004, ADR 0019. */
import { dirname, basename } from 'node:path';
import { SessionClient, settings } from './client.ts';
import type { Batch } from './types.ts';
import type { Schemas, Result } from '../schema/index.ts';
import { resolvePath } from '../files/index.ts';
import type { Clock } from '../events/index.ts';

export async function mounted(schemas: Schemas, clock: Clock, receive: (batch: Batch) => Promise<Result<void>>): Promise<Result<SessionClient>> {
  const path = await resolvePath(basename(settings.endpoint), [{ path: dirname(settings.endpoint), mode: 'ro', space: 'environment service' }]); if (!path.ok) return path;
  return SessionClient.open(path.value, schemas, clock, receive);
}
