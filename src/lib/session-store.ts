import { contentText } from "./content.js";
// The session records of a userspace, with a summary of each kept beside them in `index.json`, so a
// list of sessions is one small file and not every record: a record grows with its conversation, and a
// person with sixty of them was reading many megabytes to draw a sidebar. The index is derived, never
// authoritative: it is rebuilt from the records when it is missing, and every save of a record updates
// its entry, so the two cannot drift for long. Who may list or save is the kernel's question.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "../contracts/index.js";
import { SessionRecordSchema, SessionSummarySchema } from "../contracts/schemas/identity.js";
import { JsonDirStore } from "./json-store.js";
import { readJson, writeJson } from "./json.js";
import { parseSchema } from "./validation.js";
import { assert } from "./error.js";

/** An index entry: everything in a summary except `running`, which is the kernel's to say. */
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

const INDEX = "index.json";
const CLIP = 200;
const SessionIndexSchema = z.record(z.string(), SessionSummarySchema).superRefine((index, context) => {
  for (const [id, summary] of Object.entries(index)) {
    if (id !== summary.id) context.addIssue({ code: "custom", path: [id, "id"], message: "summary id must match its index key" });
  }
});

/** One line of text, at most `max` characters. */
export function clipText(text: string, max = CLIP): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What the index keeps about one record. */
export function summarize(rec: SessionRecord): SessionSummary {
  const said = rec.conversation.filter((m) => m.role === "user" || (m.role === "assistant" && contentText(m.content).trim()));
  const s: SessionSummary = {
    id: rec.id,
    user: rec.user,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    turns: rec.turns,
    // The record's words, clipped. What a harness adds to them is the harness's to take out where it shows them.
    first: clipText(contentText(rec.conversation.find((m) => m.role === "user")?.content)),
    last: clipText(contentText(said.at(-1)?.content)),
  };
  if (rec.parent) s.parent = rec.parent;
  return s;
}

export class SessionStore {
  private readonly records: JsonDirStore<SessionRecord>;
  /** The index of each sessions directory, once read; this process is the only writer. */
  private readonly indexes = new Map<string, Record<string, SessionSummary>>();

  constructor(idPattern: RegExp) {
    this.records = new JsonDirStore<SessionRecord>(idPattern);
  }

  load(dir: string, id: string): SessionRecord | undefined {
    const record = this.records.load(dir, id);
    if (record === undefined) return undefined;
    const parsed = parseSchema(SessionRecordSchema, record, `session ${id}`);
    assert(parsed.id === id, "session id must match its file", "invalid");
    return parsed;
  }

  /** Writes the record and its index entry. */
  save(dir: string, rec: SessionRecord): void {
    rec = parseSchema(SessionRecordSchema, rec, "session record");
    this.records.save(dir, rec);
    const index = this.index(dir);
    index[rec.id] = summarize(rec);
    writeJson(resolve(dir, INDEX), index);
  }

  /** Drops a record and its entry. Nothing happens for an id that is not there. */
  remove(dir: string, id: string): void {
    const index = this.index(dir);
    if (!(id in index)) return;
    delete index[id];
    const file = resolve(dir, `${id}.json`);
    if (existsSync(file)) unlinkSync(file);
    writeJson(resolve(dir, INDEX), index);
  }

  /** Every summary, in no particular order. Builds the index from the records the first time a directory has none. */
  summaries(dir: string): SessionSummary[] {
    return Object.values(this.index(dir));
  }

  private index(dir: string): Record<string, SessionSummary> {
    let index = this.indexes.get(dir);
    if (index) return index;
    const file = resolve(dir, INDEX);
    if (existsSync(file)) index = parseSchema(SessionIndexSchema, readJson<unknown>(file, {}), "session index");
    else {
      index = Object.fromEntries(this.records.list(dir).map((raw) => {
        const rec = parseSchema(SessionRecordSchema, raw, "stored session");
        return [rec.id, summarize(rec)];
      }));
      if (existsSync(dir) && readdirSync(dir).length) writeJson(file, index);
    }
    this.indexes.set(dir, index);
    return index;
  }
}
