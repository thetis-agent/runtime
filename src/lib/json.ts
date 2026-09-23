import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Writes through a temporary file and a rename, so a reader never sees a half-written file. */
export function writeJson(file: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, file);
}

/** A JSON file held in memory: read once, written whole on `save`. */
export class JsonFile<T> {
  value: T;

  constructor(
    readonly file: string,
    fallback: T,
    private readonly mode?: number,
  ) {
    this.value = readJson(file, fallback);
  }

  save(): void {
    writeJson(this.file, this.value, this.mode);
  }
}
