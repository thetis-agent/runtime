// The host's Docker daemon, handed to a fence as a bind of its unix socket.
//
// This is a hole in the fence, opened deliberately. A process that can talk to the daemon can start a
// container with `--privileged` and the host's root bound into it, so socket access is host root: the
// filesystem, process, capability and network rules of the fence stop applying to whatever it asks the
// daemon to run. It is on by default because on a single-operator installation the fence is not relied on
// as a boundary, and because the alternatives — a filtering proxy over the daemon API, a daemon per
// userspace, a separate build host — each cost a great deal more than they buy here. Set `fence.docker`
// to `"off"` on any installation where a fence holds code you do not already trust with the host.
//
// A unix socket is filesystem, not network, so this works in every network mode, including `none`.
// Connecting needs write permission on the socket inode, which a read-only bind still allows; the bind is
// read-only so the fence cannot unlink or replace the socket, only speak to it.
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export type DockerAccess = "auto" | "on" | "off";

/** Where the socket appears inside every fence: the path the Docker CLI looks at without being told. */
export const FENCE_DOCKER_SOCKET = "/var/run/docker.sock";

/** The host paths probed, in order, when the configuration does not name one. */
const CANDIDATES = ["/var/run/docker.sock", "/run/docker.sock"];

/**
 * Whether the kernel can actually use this socket. `connect` needs write permission on the inode, which is
 * what `access(W_OK)` answers — for the kernel's own real uid and its supplementary groups, so a daemon
 * whose socket is `root:docker` answers yes exactly when the kernel's user is in the `docker` group. A
 * socket that is there but unusable is worth telling apart from no socket at all: binding it would give the
 * fence a permission error from the CLI rather than the honest absence of Docker.
 */
function usable(path: string): boolean {
  try {
    if (!statSync(path).isSocket()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The socket paths to consider, in order. A path the operator named is the *only* candidate: naming one and
 * silently getting a different daemon because that one failed a probe is a worse outcome than no Docker at
 * all. With nothing named, `DOCKER_HOST` comes first when it is a unix endpoint — a `tcp://` one names no
 * path and cannot be bound, so it is not a candidate — then the usual places, then the rootless socket.
 */
function candidates(configured: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (configured) return [configured];
  const host = env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice("unix://".length) : undefined;
  const rootless = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "docker.sock") : undefined;
  return [host, ...CANDIDATES, rootless].filter((p): p is string => !!p);
}

/**
 * The host socket to bind into every fence, or undefined for no Docker.
 *
 * `auto` binds a socket the kernel can use and is otherwise silent, so an installation without Docker is
 * not nagged about it. `on` binds the first candidate whether or not the probe passes — a daemon that
 * starts after the kernel leaves an unusable socket now and a working one later, and the bind is `-try`, so
 * a path that is missing at open costs nothing. `off` never binds. Nothing here can fail a fence.
 */
export function dockerSocket(access: DockerAccess, configured: string | undefined, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (access === "off") return undefined;
  const paths = candidates(configured, env);
  const found = paths.find(usable);
  if (found) return found;
  if (access === "auto") return undefined;
  const path = configured ?? paths[0];
  log(`[fence] docker: ${path} is not a socket the kernel can use; binding it anyway because fence.docker is "on"`);
  return path;
}
