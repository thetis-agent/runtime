/** Confine registry delivery to a fixed cache and admit only schema-valid kernel requests; ADR 0007, ADR 0017. */
import { readFile, realpath, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap } from '../profile/bootstrap.ts';
import { assemble } from '../profile/delivery.ts';
import { Registry } from './index.ts';
import { lock } from './profile.ts';
import { retain } from './retention.ts';
import { prune } from './prune.ts';
import { snapshot } from '../snapshots/index.ts';
import { socketFrames, send } from '../ndjson/socket.ts';
import { failure, isObject } from '../schema/index.ts';
import type { Schemas, Result } from '../schema/index.ts';
import type { Connection } from '../service/lifecycle.ts';
import type { Request, Startup } from './types.ts';

async function dispatch(registry: Registry, config: Startup, request: Request, schemas: Schemas): Promise<Result<unknown>> {
  switch (request.method) {
    case 'bootstrap': {
      if (!config.sources.includes(request.source)) return failure('outside-roots', 'The bootstrap source is not a configured review directory.');
      return bootstrap(request.source, registry, config.cache, request.at);
    }
    case 'prune': return prune(registry, request.pin);
    case 'assemble': return assemble(registry, config.cache, request.layers, schemas);
    case 'inspect': return registry.inspect(request.name, request.version);
    case 'search': return registry.search(request.name, request.range);
    case 'resolve': return lock(registry, request.pins, request.facts);
    case 'retention': return retain(registry, request.live, request.defaults, request.at);
    case 'publish': {
      if (!config.sources.includes(request.source)) return failure('outside-roots', 'The publication source is not a configured package directory.');
      return registry.publish(request.source, request.note, request.at);
    }
    case 'fetch': {
      const release = await registry.inspect(request.pin.name, request.pin.version); if (!release.ok) return release;
      if (release.value.pin.commit !== request.pin.commit || release.value.pin.hash !== request.pin.hash) return failure('hash-mismatch', 'The registry version does not match the pinned hash.');
      const destination = join(config.cache, request.pin.commit);
      try {
        if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) return failure('outside-roots', 'The cached package is not a canonical directory.');
        const hash = await snapshot(destination); if (!hash.ok) return hash;
        if (hash.value !== request.pin.hash) return failure('hash-mismatch', 'The cached package does not match the pinned hash.');
        return { ok: true, value: { pin: request.pin, path: destination } };
      } catch {
        const installed = await registry.fetch(request.pin, destination); return installed.ok ? { ok: true, value: { pin: request.pin, path: destination } } : installed;
      }
    }
  }
}
export async function handler(input: unknown, schemas: Schemas): Promise<Result<(connection: Connection) => Promise<Result<void>>>> {
  const raw: unknown = JSON.parse(await readFile(new URL('../../contracts/registry/schema.json', import.meta.url), 'utf8'));
  if (!isObject(raw)) throw new Error('The committed registry schema is invalid.');
  const startup = schemas.compile<Startup>({ ...raw, $id: 'thetis://internal/registry/startup', $ref: '#/$defs/startup' });
  const validate = schemas.compile<Request>({ ...raw, $id: 'thetis://internal/registry/request', $ref: '#/$defs/request' });
  if (!startup(input)) return failure('invalid-args', 'The registry startup policy is invalid.');
  const config = structuredClone(input); await mkdir(config.cache, { recursive: true, mode: 0o700 });
  if (await realpath(config.cache) !== config.cache) return failure('outside-roots', 'The registry cache is not a canonical directory.');
  const opened = await Registry.open(config.registry, schemas); if (!opened.ok) return opened;
  let active = false;
  return { ok: true, value: async connection => {
    const frames = socketFrames(connection.socket); const first = await frames.next();
    if (first.done || !first.value.ok || !validate(first.value.value)) return send(connection.socket, { v: '1', id: 'invalid', ...failure('invalid-args', 'The registry request does not match its schema.') });
    const request = first.value.value; connection.admitted();
    if (active) return send(connection.socket, { v: '1', id: request.id, ...failure('budget', 'The registry operation pool is full.') });
    active = true;
    try { return await send(connection.socket, { v: '1', id: request.id, ...await dispatch(opened.value, config, request, schemas) }); }
    catch { return await send(connection.socket, { v: '1', id: request.id, ...failure('io', 'The registry operation failed.') }); }
    finally { active = false; }
  } };
}
