/** Keep conversation history append-only and branch views explicit; proposal §6, TE-009–011. */
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { frames } from '../../lib/ndjson/index.ts';
import { fileChunks } from '../../lib/ndjson/file.ts';
import { isObject, failure } from '../../lib/schema/index.ts';
import type { Result, Schemas } from '../../lib/schema/index.ts';
import type { Message, Prefix } from '../../contracts/turn-events/types.ts';

type Payload = { type: 'prefix'; value: Prefix } | { type: 'message'; value: Message };
export type Record = Payload & { id: string; parentId: string | null };
export const defaults = { recordBytes: 1024 * 1024, records: 100000, fileBytes: 128 * 1024 * 1024 };

export class Conversation {
  readonly #records = new Map<string, Record>();
  readonly #path: string;
  readonly #schemas: Schemas;
  readonly #id: () => string;
  #head: string | null = null;
  #bytes = 0;
  #writing = false;
  constructor(path: string, schemas: Schemas, id: () => string = randomUUID) { this.#path = path; this.#schemas = schemas; this.#id = id; }
  get head(): string | null { return this.#head; }

  async load(): Promise<Result<void, 'io' | 'budget'>> {
    try {
      const file = await open(this.#path, 'a', 0o600); await file.close();
      this.#records.clear(); this.#head = null; this.#bytes = 0;
      for await (const frame of frames(fileChunks(this.#path), defaults.recordBytes)) {
        if (!frame.ok) return failure('io', 'The conversation contains an invalid or incomplete record.');
        const row = this.#parse(frame.value);
        if (!row || this.#records.has(row.id) || row.parentId !== null && !this.#records.has(row.parentId)) return failure('io', 'The conversation branch references an invalid record.');
        this.#bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (this.#records.size >= defaults.records || this.#bytes > defaults.fileBytes) return failure('budget', 'The conversation storage pool is full.');
        this.#records.set(row.id, row); this.#head = row.id;
      }
      return { ok: true, value: undefined };
    } catch { return failure('io', 'The conversation could not be loaded.'); }
  }

  async append(payload: Payload, parentId = this.#head): Promise<Result<Record, 'io' | 'budget'>> {
    if (this.#writing) return failure('budget', 'The conversation already has an active writer.');
    if (parentId !== null && !this.#records.has(parentId)) return failure('io', 'The conversation parent does not exist.');
    const row = { ...structuredClone(payload), id: this.#id(), parentId };
    if (this.#records.has(row.id)) throw new Error('Conversation ids must be unique.');
    const bytes = `${JSON.stringify(row)}\n`;
    if (Buffer.byteLength(bytes) > defaults.recordBytes || this.#records.size >= defaults.records || this.#bytes + Buffer.byteLength(bytes) > defaults.fileBytes) return failure('budget', 'The conversation storage pool is full.');
    this.#writing = true;
    try {
      const file = await open(this.#path, 'a', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      this.#records.set(row.id, row); this.#head = row.id; this.#bytes += Buffer.byteLength(bytes);
      return { ok: true, value: structuredClone(row) };
    } catch { return failure('io', 'The conversation record could not be saved.'); }
    finally { this.#writing = false; }
  }

  project(head = this.#head): { prefix: Prefix | undefined; history: Message[] } {
    const path: Record[] = [];
    for (let id = head; id !== null;) {
      const row = this.#records.get(id);
      if (!row) throw new Error('The requested conversation branch does not exist.');
      path.push(row); id = row.parentId;
    }
    let prefix: Prefix | undefined;
    const history: Message[] = [];
    for (const row of path.reverse()) {
      if (row.type === 'prefix') prefix = structuredClone(row.value);
      else history.push(structuredClone(row.value));
    }
    return { prefix, history };
  }

  #parse(value: unknown): Record | undefined {
    if (!isObject(value) || typeof value['id'] !== 'string' || !(value['parentId'] === null || typeof value['parentId'] === 'string')) return undefined;
    const common = { id: value['id'], parentId: value['parentId'] };
    if (value['type'] === 'prefix' && this.#schemas.validator<Prefix>('turn-events', 'prefix')(value['value'])) return { ...common, type: 'prefix', value: value['value'] };
    if (value['type'] === 'message' && this.#schemas.validator<Message>('turn-events', 'message')(value['value'])) return { ...common, type: 'message', value: value['value'] };
    return undefined;
  }
}

export function compact(history: readonly Message[], retain: number): Message[] {
  const kept = new Set<number>();
  const groups: number[][] = [];
  let group: number[] | undefined;
  let calls = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (message.protected || index >= history.length - retain) kept.add(index);
    if (message.role === 'assistant') {
      calls = new Set(message.content.filter(content => content.type === 'tool_call').map(content => content.id));
      group = calls.size ? [index] : undefined;
      if (group) groups.push(group);
    } else if (message.role === 'tool' && message.toolCallId && calls.has(message.toolCallId)) group?.push(index);
    else if (message.role !== 'tool') { group = undefined; calls = new Set(); }
  }
  for (const indices of groups) if (indices.some(index => kept.has(index))) for (const index of indices) kept.add(index);
  return history.filter((_message, index) => kept.has(index)).map(message => structuredClone(message));
}
