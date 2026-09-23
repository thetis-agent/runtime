import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { now } from "./ids.js";

/** One row of the journal. What goes in a row, and when, is the caller's decision. */
export interface JournalRow {
  at: string;
  kind: string;
  actor?: string;
  target?: string;
  data?: Record<string, unknown>;
}

export interface JournalFilter {
  actor?: string;
  target?: string;
  kind?: string;
}

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * An append-only record: one JSON object per line in `<home>/journal.jsonl`. When the file outgrows
 * the limit it rolls to `journal.1.jsonl` and starts over, so the journal never fills the disk.
 */
export class Journal {
  private readonly file: string;

  constructor(home: string, private readonly maxBytes = MAX_BYTES) {
    this.file = resolve(home, "journal.jsonl");
  }

  append(row: Omit<JournalRow, "at">): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) {
        renameSync(this.file, this.file.replace(/\.jsonl$/, ".1.jsonl"));
      }
      appendFileSync(this.file, JSON.stringify({ at: now(), ...row }) + "\n");
    } catch (err) {
      console.error(`[journal] could not write: ${(err as Error).message}`);
    }
  }

  /** The newest rows first, at most `limit`, optionally only those about one actor, target, or kind. */
  tail(limit = 200, filter: JournalFilter = {}): JournalRow[] {
    if (!existsSync(this.file)) return [];
    const rows: JournalRow[] = [];
    const lines = readFileSync(this.file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const row = JSON.parse(lines[i]) as JournalRow;
        if (matches(row, filter)) rows.push(row);
      } catch {
        continue;
      }
    }
    return rows;
  }
}

function matches(row: JournalRow, filter: JournalFilter): boolean {
  if (filter.actor && row.actor !== filter.actor) return false;
  if (filter.target && row.target !== filter.target) return false;
  if (filter.kind && row.kind !== filter.kind) return false;
  return true;
}
