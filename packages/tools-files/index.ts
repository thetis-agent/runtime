/** Enforce granted roots and request mode on every file operation; TE-018–020, proposal §13. */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Schemas, failure, isObject } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
import { readBounded } from '../../lib/files/read-bounded.ts';
import { resolvePath } from '../../lib/files/index.ts';
import type { SpillSink } from '../../lib/spill/index.ts';
import type { CallRequest, CallAnswer, OfferRequest } from '../../contracts/turn-events/types.ts';
import { definitions } from './definitions.ts';
import { readLines, list, find } from './read.ts';
import { search } from './search.ts';

export const settings = { editBytes: 4 * 1024 * 1024, maxResults: 1000 };
const schemas = new Schemas();

async function edit(path: string, args: Record<string, unknown>): Promise<Result<void, 'io' | 'budget' | 'not-found' | 'not-unique'>> {
  const bytes = await readBounded(path, settings.editBytes); if (!bytes.ok) return bytes;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
  const old = typeof args['old_text'] === 'string' ? args['old_text'] : '';
  const replacement = typeof args['new_text'] === 'string' ? args['new_text'] : '';
  const index = text.indexOf(old);
  if (index < 0) return failure('not-found', 'The exact text was not found.');
  if (args['replace_all'] !== true && text.indexOf(old, index + old.length) >= 0) return failure('not-unique', 'The exact text occurs more than once.');
  const next = args['replace_all'] === true ? text.replaceAll(old, replacement) : text.slice(0, index) + replacement + text.slice(index + old.length);
  if (Buffer.byteLength(next) > settings.editBytes) return failure('budget', 'The edited file exceeds its byte budget.');
  await writeFile(path, next); return { ok: true, value: undefined };
}

async function operation(request: CallRequest, path: string, args: Record<string, unknown>, sink: SpillSink): Promise<Result<void>> {
  switch (request.name) {
    case 'read_path': return readLines(path, sink, typeof args['offset'] === 'number' ? args['offset'] : 1, typeof args['limit'] === 'number' ? args['limit'] : 200);
    case 'list_path': return list(path, sink);
    case 'find_files': return find(path, typeof args['glob'] === 'string' ? args['glob'] : '**/*', typeof args['max_results'] === 'number' ? args['max_results'] : settings.maxResults, sink);
    case 'search_files': return search(path, args, sink);
    case 'edit_path': return edit(path, args);
    case 'write_path': {
      const contents = typeof args['contents'] === 'string' ? args['contents'] : '';
      if (Buffer.byteLength(contents) > settings.editBytes) return failure('budget', 'The file exceeds its byte budget.');
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); return { ok: true, value: undefined };
    }
    case 'delete_path': await rm(path, { recursive: args['recursive'] === true }); return { ok: true, value: undefined };
    default: return failure('gone', `${request.name} no longer exists.`);
  }
}

export const stages = {
  source: 'tools-files@1.0.0',
  offer(request: OfferRequest) {
    return Promise.resolve(definitions.filter(tool => !request.mode.readOnly || tool.readOnly).map(tool => structuredClone(tool)));
  },
  async call(request: CallRequest, sink: SpillSink): Promise<CallAnswer> {
    const tool = definitions.find(item => item.name === request.name);
    if (!tool) return { id: request.id, ok: false, error: { code: 'gone', message: `${request.name} no longer exists.` } };
    if (!isObject(request.args) || !schemas.arguments(tool.schema, request.args)) return { id: request.id, ok: false, error: { code: 'invalid-args', message: `${request.name} arguments do not match its schema.` } };
    const deny = request.mode['deny'];
    if (request.mode['readOnly'] === true && !tool.readOnly || Array.isArray(deny) && (deny.includes(request.name) || deny.includes(`tools-files/${request.name}`))) return { id: request.id, ok: false, error: { code: 'read-only-mode', message: `${request.name} is not available in this mode.` } };
    const requested = typeof request.args['path'] === 'string' ? request.args['path'] : request.roots[0]?.path ?? '';
    const resolved = await resolvePath(requested, request.roots, !tool.readOnly);
    if (!resolved.ok) return { id: request.id, ok: false, error: resolved.error };
    try {
      const result = await operation(request, resolved.value, request.args, sink);
      if (result.ok) return { id: request.id, ok: true };
      const error = { id: request.id, ok: false, error: result.error };
      const validate = schemas.validator<CallAnswer>('turn-events', 'callAnswer');
      return validate(error) ? error : { id: request.id, ok: false, error: { code: 'io', message: result.error.message } };
    } catch { return { id: request.id, ok: false, error: { code: 'io', message: `${request.name} could not access ${requested}.` } }; }
  },
  init(): Promise<void> { return schemas.load(); }
};
