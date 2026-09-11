/** Serve only table-listed files under a canonical root, with bounded reads, and ETag revalidation so a
 * changed file is never served stale; ADR 0005, ADR 0037. */
import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolvePath, boundedFile } from '@/lib/files/index.ts';
import type { Root } from '@/lib/files/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';

export const limits = { fileBytes: 4194304, files: 256 };

export interface Asset { path: string; file: string; type: string; size: number; sha256: string; absolute: string; body?: Buffer }
export interface Table { root: string; assets: readonly Asset[] }

/** Offered a manifest row, returns the text edit that row needs, or nothing to serve the file as it lies.
 *
 * A gateway whose pages carry per-installation text — a name, a colour — has to put it in before the
 * bytes leave, and the alternative (a placeholder the browser fills in after boot) shows the wrong
 * name for the length of a round trip and cannot reach a <title> or a tab icon at all. Returning a
 * function rather than a string is what keeps a binary asset unread: only a row the caller claims is
 * opened as text. The edited bytes are hashed and measured like any other row, so revalidation still
 * describes what was actually served. */
export type Rewrite = (asset: { path: string; file: string; type: string }) => ((text: string) => string) | undefined;

interface ManifestEntry { path: string; file: string; type: string }
interface Manifest { assets: ManifestEntry[] }
const manifestSchema = {
  type: 'object', additionalProperties: false, required: ['assets'],
  properties: { assets: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path', 'file', 'type'],
    properties: { path: { type: 'string' }, file: { type: 'string' }, type: { type: 'string' } },
  } } },
};

const csp = "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";
const security = { 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

async function hash(path: string): Promise<Result<string, 'io'>> {
  try {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
    return { ok: true, value: digest.digest('hex') };
  } catch { return failure('io', `${path} could not be hashed.`); }
}

async function rewritten(path: string, edit: (text: string) => string): Promise<Result<Buffer, 'io'>> {
  try { return { ok: true, value: Buffer.from(edit(await readFile(path, 'utf8')), 'utf8') }; }
  catch { return failure('io', `${path} could not be read as text.`); }
}

/** Read the committed manifest once, canonicalise every file against root, refuse on doubt; ADR 0005. */
export async function load(root: string, manifestPath: string, schemas: Schemas, rewrite?: Rewrite): Promise<Result<Table>> {
  let text: string;
  try { text = await readFile(manifestPath, 'utf8'); }
  catch { return failure('not-found', `${manifestPath} does not exist.`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return failure('invalid-args', `${manifestPath} is not valid JSON.`); }
  const valid = schemas.compile<Manifest>(manifestSchema);
  if (!valid(parsed)) return failure('invalid-args', `${manifestPath} does not match the asset manifest shape.`);
  if (parsed.assets.length > limits.files) return failure('budget', `${manifestPath} lists more than ${String(limits.files)} assets.`);
  const roots: Root[] = [{ path: root, mode: 'ro', space: 'assets' }];
  const seen = new Set<string>(); const rows: Asset[] = [];
  for (const entry of parsed.assets) {
    if (!entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('?')) return failure('invalid-args', `${entry.path} is not a servable asset path.`);
    if (seen.has(entry.path)) return failure('invalid-args', `${entry.path} is listed twice in the asset manifest.`);
    seen.add(entry.path);
    const resolved = await resolvePath(entry.file, roots);
    if (!resolved.ok) return resolved;
    const bounded = await boundedFile(resolved.value, limits.fileBytes);
    if (!bounded.ok) return bounded;
    const edit = rewrite?.(entry);
    if (edit) {
      const edited = await rewritten(resolved.value, edit);
      if (!edited.ok) return edited;
      if (edited.value.length > limits.fileBytes) return failure('budget', `${entry.file} is larger than ${String(limits.fileBytes)} bytes once filled in.`);
      rows.push({ path: entry.path, file: entry.file, type: entry.type, size: edited.value.length, sha256: createHash('sha256').update(edited.value).digest('hex'), absolute: resolved.value, body: edited.value });
      continue;
    }
    const hashed = await hash(resolved.value);
    if (!hashed.ok) return hashed;
    const info = await stat(resolved.value);
    rows.push({ path: entry.path, file: entry.file, type: entry.type, size: info.size, sha256: hashed.value, absolute: resolved.value });
  }
  return { ok: true, value: { root: await realpath(root), assets: rows } };
}

/** Join tables served from one origin, refusing a path two packages both claim; ADR 0006, ADR 0038 §1.
 *
 * `respond` matches `path` literally and never reads `root`, so a joined table needs no common root:
 * each row keeps the absolute file it was canonicalised to under its own package's root. The combined
 * count is bounded again because `load` only bounds one manifest at a time. */
export function merge(tables: readonly Table[]): Result<Table, 'invalid-args' | 'budget'> {
  const seen = new Map<string, string>(); const assets: Asset[] = [];
  for (const table of tables) {
    for (const asset of table.assets) {
      const owner = seen.get(asset.path);
      if (owner !== undefined) return failure('invalid-args', `${asset.path} is served by both ${owner} and ${table.root}.`);
      seen.set(asset.path, table.root); assets.push(asset);
    }
  }
  if (assets.length > limits.files) return failure('budget', `The joined asset table lists more than ${String(limits.files)} assets.`);
  return { ok: true, value: { root: tables[0]?.root ?? '', assets } };
}

function pathnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const query = url.indexOf('?'); const raw = query === -1 ? url : url.slice(0, query);
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return (Array.isArray(header) ? header.join(',') : header).split(',').map(part => part.trim()).some(part => part === etag || part === '*');
}

function json(response: ServerResponse, status: number, result: Result<unknown>, extra: Record<string, string> = {}): Result<void> {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', ...security, ...extra });
  response.end(JSON.stringify(result));
  return { ok: true, value: undefined };
}

/** Answer only GET/HEAD for a table-listed path, streamed and revalidated by hash, never buffered whole; ADR 0037. */
export async function respond(table: Table, request: IncomingMessage, response: ServerResponse): Promise<Result<void>> {
  const method = request.method ?? '';
  if (method !== 'GET' && method !== 'HEAD') return json(response, 405, failure('not-offered', 'This asset endpoint serves only GET and HEAD.'), { allow: 'GET, HEAD' });
  const path = pathnameOf(request.url);
  const asset = path === undefined ? undefined : table.assets.find(row => row.path === path);
  if (!asset) return json(response, 404, failure('not-found', `${path ?? request.url ?? ''} is not a served asset.`));
  if (request.headers.range !== undefined) return json(response, 416, failure('invalid-args', 'This asset endpoint does not support byte ranges.'), { 'accept-ranges': 'none' });
  const etag = `"${asset.sha256}"`; const cacheControl = asset.type === 'text/html' ? 'no-store' : 'no-cache';
  if (matchesEtag(request.headers['if-none-match'], etag)) {
    response.writeHead(304, { etag, 'cache-control': cacheControl, 'accept-ranges': 'none', ...security }); response.end();
    return { ok: true, value: undefined };
  }
  response.writeHead(200, { 'content-type': asset.type, 'content-length': String(asset.size), etag, 'cache-control': cacheControl, 'accept-ranges': 'none', ...security });
  if (method === 'HEAD') { response.end(); return { ok: true, value: undefined }; }
  // A rewritten row was filled in at load and never touches the disk again: its bytes are the served bytes.
  if (asset.body) { response.end(asset.body); return { ok: true, value: undefined }; }
  try { await pipeline(createReadStream(asset.absolute), response); return { ok: true, value: undefined }; }
  catch { if (!response.writableEnded) response.destroy(); return failure('io', `${asset.path} could not be streamed.`); }
}
