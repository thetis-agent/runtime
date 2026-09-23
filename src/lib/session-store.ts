// The session records of a userspace, with a summary of each kept beside them in `index.json`, so a
// list of sessions is one small file and not every record: a record grows with its conversation, and a
// person with sixty of them was reading many megabytes to draw a sidebar. The index is derived, never
// authoritative: it is rebuilt from the records when it is missing, and every save of a record updates
// its entry, so the two cannot drift for long. Who may list or save is the kernel's question.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionRecord, SessionSummaryRef } from "../contracts/index.js";
import { JsonDirStore } from "./json-store.js";
import { readJson, writeJson } from "./json.js";

/** An index entry: everything in a summary except `running`, which is the kernel's to say. */
export type SessionSummary = Omit<SessionSummaryRef, "running">;

const INDEX = "index.json";
const CLIP = 200;

/** One line of text, at most `max` characters. */
export function clipText(text: string, max = CLIP): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What the index keeps about one record. */
export function summarize(rec: SessionRecord): SessionSummary {
  const said = rec.conversation.filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim()));
  const s: SessionSummary = {
    id: rec.id,
    user: rec.user,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    turns: rec.turns,
    // The record's words, clipped. What a harness adds to them is the harness's to take out where it shows them.
    first: clipText(rec.conversation.find((m) => m.role === "user")?.content ?? ""),
    last: clipText(said.at(-1)?.content ?? ""),
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
    return this.records.load(dir, id);
  }

  /** Writes the record and its index entry. */
  save(dir: string, rec: SessionRecord): void {
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
    if (existsSync(file)) index = readJson<Record<string, SessionSummary>>(file, {});
    else {
      index = Object.fromEntries(this.records.list(dir).map((rec) => [rec.id, summarize(rec)]));
      if (existsSync(dir) && readdirSync(dir).length) writeJson(file, index);
    }
    this.indexes.set(dir, index);
    return index;
  }
}
