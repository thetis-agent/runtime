// A package's whole module graph, fresh when any file of the package changes. A module is cached by its URL
// for the life of the process, so the host and the userspace agent import a package's entry with `?v=<the
// newest mtime of the package's code>`; before this, only the entry was fresh, and the files it imported were
// the first-loaded copies until a restart -- an edited `lib/ssh.js` was never seen, and an entry that asked it
// for a new export died with "does not provide an export named isWithin". A resolve hook now carries the
// entry's `v` to every module that entry reaches inside the same package, so the whole graph is one version.
// What lies outside the package -- its dependencies, the runtime, zod -- keeps one copy for everyone.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeMtime } from "./freshness.js";

let installed = false;

/**
 * Installs the resolve hook, once per process. Only an ESM `import` whose parent URL carries `?v=` is
 * touched, and only when the child it resolves to is a file of the parent's own package (not under a
 * `node_modules` inside it) that has no query of its own; everything else resolves exactly as before.
 */
export function installFreshImports(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (!parent?.startsWith("file:") || !parent.includes("?") || !resolved.url.startsWith("file:") || !context.conditions?.includes("import")) return resolved;
      const v = new URL(parent).searchParams.get("v");
      if (!v || new URL(resolved.url).search) return resolved;
      const root = packageRoot(fileURLToPath(parent));
      return root && inPackage(root, fileURLToPath(resolved.url)) ? { ...resolved, url: `${resolved.url}?v=${encodeURIComponent(v)}` } : resolved;
    },
  });
}

/**
 * Imports `entry` of the package at `root` so that a change to any of the package's files is a new module
 * graph, and no change is the graph already loaded. Installs the hook on first use.
 */
export async function importFresh(entry: string, root: string): Promise<Record<string, unknown>> {
  installFreshImports();
  return (await import(`${pathToFileURL(entry).href}?v=${codeMtime(root)}`)) as Record<string, unknown>;
}

/** The package a file belongs to: the nearest directory above it whose package.json has a name. */
function packageRoot(file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name) return dir;
      } catch {
        // A manifest that does not parse names no package; keep looking above it.
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function inPackage(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !!rel && !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}
