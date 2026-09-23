// How the system answers "is the running code older than what is on disk?". A process holds its module
// graph from the moment it started, so the only honest comparison is between a recorded start time and the
// newest mtime under the directories that were loaded — the runtime's `dist/src` tree and CLI adapter, or one
// userspace's installed package roots. Both callers sit behind a status endpoint that a page may poll, so
// the walk is deliberately cheap: files only, a handful of pruned directory names, and a short cache.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Never walked, because a change in one of these does not need anything reloaded and a reload is not free —
 * it ends that person's shell sessions. `node_modules` is dependencies rather than this repository's code
 * (and is mostly symlinks into it, so walking it would double the work); `.git` changes on every commit
 * without any code changing; `dist/test` is compiled tests. `ui` is browser files, which the gateway
 * re-reads from disk on every request, and `skills` is text read per turn: both are already live, so
 * reporting them as stale would send someone to kill their own shells for nothing.
 *
 * What is left is module code, and all of it counts — not only a service's entry. A package's entry is
 * imported with a modification-time query, but the files that entry *imports* are not, so they are only
 * re-read by a new agent process. That is why this walks a whole package root rather than one file.
 */
const SKIP_NAMES = new Set(["node_modules", ".git", "ui", "skills", "bench"]);

/**
 * How long one answer is reused. Long enough that a page polling every second costs one walk in three,
 * short enough that a person who rebuilds and then looks does not see a stale answer they must puzzle over.
 */
const CACHE_MS = 3_000;

/** Bound on the cache: one entry per workspace on a large installation, plus the daemon's own set. */
const CACHE_MAX = 64;

const cache = new Map<string, { at: number; mtime: number }>();

/** The newest `mtimeMs` under `dirs`, or 0 when there is nothing to find. A missing directory is skipped. */
export function newestMtime(dirs: string[]): number {
  const key = [...dirs].sort().join("\0");
  const at = Date.now();
  const hit = cache.get(key);
  if (hit && at - hit.at < CACHE_MS) return hit.mtime;
  let mtime = 0;
  for (const dir of dirs) mtime = Math.max(mtime, walk(dir));
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at, mtime });
  return mtime;
}

function walk(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // A directory that is absent or unreadable is one this process did not load code from.
  }
  let newest = 0;
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (entry.name === "test" && basename(dir) === "dist") continue;
      newest = Math.max(newest, walk(join(dir, entry.name)));
    } else if (entry.isFile()) {
      // Symlinks are left alone: the trees that matter are built output, and following links would risk
      // both a cycle and counting the same file twice.
      try {
        newest = Math.max(newest, statSync(join(dir, entry.name)).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return newest;
}
