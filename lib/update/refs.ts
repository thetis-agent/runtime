/** Parse a git smart-HTTP reference advertisement into pinned release tags, trusting nothing about its shape or size; ADR 0048, GN-002. */
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const refsLimits = { advertisementBytes: 1048576, refs: 4096 };

export interface Tag { tag: string; commit: string }

type Code = 'invalid-args' | 'budget';

const releaseTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const refLine = /^([0-9a-f]{40}) (.+)$/u;
const serviceHeader = '# service=git-upload-pack\n';

interface Packet { readonly payload: string | undefined; readonly next: number }

function readPacket(advertisement: Buffer, offset: number, decoder: TextDecoder): Result<Packet, Code> {
  if (offset + 4 > advertisement.length) return failure('invalid-args', 'The reference advertisement ends inside a packet length prefix.');
  const header = advertisement.toString('latin1', offset, offset + 4);
  if (!/^[0-9a-f]{4}$/u.test(header)) return failure('invalid-args', 'The reference advertisement has a malformed packet length prefix.');
  const size = Number.parseInt(header, 16);
  if (size === 0) return { ok: true, value: { payload: undefined, next: offset + 4 } };
  if (size < 4 || offset + size > advertisement.length) return failure('invalid-args', 'The reference advertisement has a packet longer than the bytes it carries.');
  try {
    return { ok: true, value: { payload: decoder.decode(advertisement.subarray(offset + 4, offset + size)), next: offset + size } };
  } catch {
    return failure('invalid-args', 'The reference advertisement has a packet payload that is not valid UTF-8.');
  }
}

/** Strip the first line's NUL-separated capability list and its trailing newline, leaving "<sha> <name>". */
function body(payload: string): string {
  const nul = payload.indexOf('\0');
  const cut = nul === -1 ? payload : payload.slice(0, nul);
  return cut.endsWith('\n') ? cut.slice(0, -1) : cut;
}

function collect(advertisement: Buffer): Result<readonly string[], Code> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  let packets = 0;
  const next = (): Result<Packet, Code> => {
    packets += 1;
    if (packets > refsLimits.refs) return failure('budget', 'The reference advertisement exceeds its packet-count limit.');
    return readPacket(advertisement, offset, decoder);
  };
  const service = next(); if (!service.ok) return service;
  if (service.value.payload !== serviceHeader) return failure('invalid-args', 'The reference advertisement is missing the git-upload-pack service header.');
  offset = service.value.next;
  const gap = next(); if (!gap.ok) return gap;
  if (gap.value.payload !== undefined) return failure('invalid-args', 'The reference advertisement is missing the flush packet after its service header.');
  offset = gap.value.next;
  const lines: string[] = [];
  for (;;) {
    const packet = next(); if (!packet.ok) return packet;
    offset = packet.value.next;
    if (packet.value.payload === undefined) break;
    lines.push(packet.value.payload);
  }
  if (offset !== advertisement.length) return failure('invalid-args', 'The reference advertisement has trailing bytes after its final flush packet.');
  return { ok: true, value: lines };
}

export function parseTags(advertisement: Buffer): Result<readonly Tag[], Code> {
  if (advertisement.length > refsLimits.advertisementBytes) return failure('budget', 'The reference advertisement exceeds its byte limit.');
  const lines = collect(advertisement); if (!lines.ok) return lines;
  const commits = new Map<string, string>();
  const seen = new Set<string>();
  for (const payload of lines.value) {
    const match = refLine.exec(body(payload));
    if (!match) return failure('invalid-args', 'A reference line has no 40-lowercase-hex sha and name.');
    const [, sha = '', name = ''] = match;
    if (name === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -'^{}'.length);
      if (commits.has(base)) commits.set(base, sha);
      continue;
    }
    if (seen.has(name)) return failure('invalid-args', 'The reference advertisement names the same ref twice.');
    seen.add(name);
    if (name.startsWith('refs/tags/') && releaseTag.test(name.slice('refs/tags/'.length))) commits.set(name, sha);
  }
  const tags = [...commits.entries()].map(([name, commit]) => ({ tag: name.slice('refs/tags/'.length), commit }));
  return { ok: true, value: tags.sort((a, b) => a.tag.localeCompare(b.tag)) };
}
