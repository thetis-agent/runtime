import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assert } from "./error.js";
import { readJson, writeJson } from "./json.js";

/**
 * Records kept as one JSON file each, `<dir>/<id>.json`. The id pattern is checked before it becomes a
 * path, so a caller-supplied id can never leave the directory.
 */
export class JsonDirStore<T extends { id: string }> {
  constructor(private readonly idPattern: RegExp) {}

  load(dir: string, id: string): T | undefined {
    const file = this.file(dir, id);
    return existsSync(file) ? readJson<T>(file, undefined as never) : undefined;
  }

  save(dir: string, rec: T): void {
    writeJson(this.file(dir, rec.id), rec);
  }

  list(dir: string): T[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && this.idPattern.test(f.slice(0, -5)))
      .map((f) => readJson<T>(resolve(dir, f), undefined as never));
  }

  private file(dir: string, id: string): string {
    assert(this.idPattern.test(id), `invalid id: ${id}`);
    return resolve(dir, `${id}.json`);
  }
}
