// Git urls as repositories: whether two spellings name the same one, and how the installation reaches one
// with the key it holds for it.
//
// `repoKey` is a normal form -- the host, then the path, with the transport, the user, the port, a trailing
// `.git` and a trailing slash all taken off, because none of them changes which repository is on the other
// end. `git@github.com:o/r.git`, `https://github.com/o/r` and `ssh://git@github.com:22/o/r.git` are one
// repository; `file:///srv/reg.git` and `/srv/reg` are one repository; a host is never a local path.
// Getting it wrong in the safe direction costs a key that is not offered; the form is deliberately
// conservative, so anything it cannot parse comes back as itself and matches nothing but itself.
//
// `repoRoute` is the other half. A repository key is the installation's, held by the system fence's agent
// and never by a person's, and it must be offered for that repository and no other: GitHub accepts the first
// key that authenticates as *anything*, so an agent holding two deploy keys reaches one of the two
// repositories and is refused by the other. ssh cannot see which repository git is asking for, so each
// credentialed repository gets a host alias of its own, and git is told to reach the repository through it:
// `url.<alias url>.insteadOf <each spelling>`. The alias's ssh block names that key's public half with
// `IdentitiesOnly`, which makes ssh offer exactly the agent key matching it.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The normal form of a git url: `host/path` for a hosted repository, an absolute filesystem path for a
 * local one. The host is lowercased because DNS is case-insensitive; the path of a hosted repository is
 * lowercased too, because every git host this is pointed at treats `Thetis-Agent/packages` and
 * `thetis-agent/packages` as one repository. A local path keeps its case, because the filesystem under it does.
 */
export function repoKey(raw: unknown): string {
  const hosted = parseHosted(raw);
  if (hosted) return `${hosted.host.toLowerCase()}/${hosted.path.toLowerCase()}`;
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  // `file://host/path` is legal and the host is always local or empty; the path is what matters.
  if (scheme && scheme[1].toLowerCase() === "file") return localKey(scheme[2].replace(/^[^/]*/, ""));
  return localKey(s);
}

export function sameRepository(a: unknown, b: unknown): boolean {
  const x = repoKey(a);
  const y = repoKey(b);
  return Boolean(x) && x === y;
}

/** The name a url suggests for a registry or a target with none: the last path segment, without `.git`. */
export function slugOfUrl(url: unknown): string {
  const last = repoKey(url).split("/").filter(Boolean).at(-1) ?? "";
  return last || "registry";
}

/** A hosted repository, taken apart: what `repoRoute` needs to reach it over ssh. */
export interface HostedRepo {
  /** Lowercased host, no user, no port. */
  host: string;
  /** The ssh port when the url named one other than 22. */
  port?: number;
  /** The ssh user: the one the url named for ssh, else `git`. */
  user: string;
  /** The path on the host as written, without a leading slash, a trailing slash or a trailing `.git`. */
  path: string;
}

/**
 * How the system fence reaches one repository with the key it holds for it.
 *
 * `alias` is the ssh host alias (`thetis-repo-<12 hex of the repoKey's sha256>`), stable for the repository
 * whatever spelling it was given in. `url` is the one git is sent to, `ssh://<user>@<alias>/<path>.git`.
 * `insteadOf` lists the spellings git may be handed for the repository, each to be rewritten to `url`: the
 * configured spelling exactly as written, and the `.git` form of it over scp-like ssh, `ssh://`, `https://`
 * and `git://`. Only `.git` forms are added: `insteadOf` matches a prefix, and `git@host:o/r` would also
 * match `git@host:o/r-other.git` and send another repository this one's key. The configured spelling is
 * kept even without `.git`, because it is the one every pinned source carries.
 *
 * Undefined for a local path or anything that is not a hosted url.
 */
export interface RepoRoute {
  key: string;
  alias: string;
  host: string;
  port?: number;
  user: string;
  url: string;
  insteadOf: string[];
}

export function repoRoute(raw: unknown): RepoRoute | undefined {
  const hosted = parseHosted(raw);
  if (!hosted) return undefined;
  const key = `${hosted.host.toLowerCase()}/${hosted.path.toLowerCase()}`;
  const alias = `thetis-repo-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const { host, port, user, path } = hosted;
  const at = port ? `${host}:${port}` : host;
  const spellings = [
    String(raw).trim(),
    ...(port ? [] : [`${user}@${host}:${path}.git`]),
    `ssh://${user}@${at}/${path}.git`,
    `https://${host}/${path}.git`,
    `git://${host}/${path}.git`,
  ];
  return { key, alias, host, ...(port ? { port } : {}), user, url: `ssh://${user}@${alias}/${path}.git`, insteadOf: [...new Set(spellings)] };
}

/** `ssh`, `git+ssh`, `https`, `http` and `git` urls and the scp-like form; undefined for anything else. */
export function parseHosted(raw: unknown): HostedRepo | undefined {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!["ssh", "git+ssh", "ssh+git", "https", "http", "git"].includes(proto)) return undefined;
    let rest = scheme[2];
    let user: string | undefined;
    const slash = rest.indexOf("/");
    const at = rest.indexOf("@");
    if (at !== -1 && (slash === -1 || at < slash)) {
      user = rest.slice(0, at).split(":")[0];
      rest = rest.slice(at + 1);
    }
    const cut = rest.indexOf("/");
    if (cut === -1) return undefined;
    const [host, portText] = rest.slice(0, cut).split(":");
    const path = trimRepo(rest.slice(cut).replace(/^\/+/, ""));
    if (!host || !path) return undefined;
    const isSsh = proto.includes("ssh");
    const port = isSsh && portText && portText !== "22" ? Number(portText) : undefined;
    return { host: host.toLowerCase(), ...(port ? { port } : {}), user: (isSsh && user) || "git", path };
  }
  // The scp-like form git accepts without a scheme: `[user@]host:path`. A leading `/` or `.` means a plain
  // path, and a Windows-style `C:` is not something this installation deals in.
  const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(s);
  if (!scp || s.startsWith("/") || s.startsWith(".")) return undefined;
  const path = trimRepo(scp[3].replace(/^\/+/, ""));
  return path ? { host: scp[2].toLowerCase(), user: scp[1] || "git", path } : undefined;
}

function trimRepo(path: string): string {
  return path.replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * A local path, as canonical as the filesystem will say. The symlinks are resolved before the `.git`
 * suffix is taken off and not after, because a bare repository is the directory that ends in `.git`: the
 * path with the suffix is the one that exists and can be resolved, and `/srv/reg` never will be.
 */
function localKey(path: string): string {
  const abs = resolve(path);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    try {
      real = realpathSync(trimRepo(abs));
    } catch {
      real = abs;
    }
  }
  return trimRepo(real);
}
