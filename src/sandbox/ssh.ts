// One ssh-agent per fence, holding only that fence's keys.
//
// The alternative is to bind a key directory in, and it is the wrong shape. A host `~/.ssh` is a bag of
// unrelated credentials -- a deploy key, a cloud key, a personal key -- so binding the directory hands all
// of them to every fence and to every package inside it. Worse, a key file is stealable once and then it
// is yours for as long as it is valid: the fence can copy it out, and nothing afterwards can tell that it
// did. The blast radius is the key's whole lifetime.
//
// An agent inverts that. The private key stays on the kernel's side of a unix socket, the fence can ask
// for a signature but never for the key, the grant names individual keys rather than a directory, the
// agent dies with the fence, and revoking is killing a process. What the fence gets is the *use* of a
// credential while it is open, which is the thing it actually needs.
//
// The shape is borrowed wholesale from the egress helper: a kernel-owned child, placed in the fence's
// cgroup, stopped by the same cleanup list when the fence closes.
//
// **What this does not buy, on an installation like this one.** "The fence can never copy the key" is true
// of the fence's own filesystem view and false in practice while `fence.docker` binds the host's Docker
// socket, because a fence can ask the daemon for a container with the host root in it and read `~/.ssh`
// there. Socket access is host root, deliberately, and this does not claw that back. What the agent is
// actually worth here is narrower and still worth having: a grant names one key rather than a directory,
// so a fence gets the credential it was given and not the other three in the same `~/.ssh`; the key dies
// with the fence and revoking is killing a process; `known_hosts` and the client options come with it, so
// ssh fails in a second instead of hanging on a prompt; and every grant is journalled. Those are
// organisation and operability properties. Treat the containment as a tidiness boundary, as with the rest
// of the fence on a single-operator installation, and turn `fence.docker` off if it has to be more.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the agent socket and its client files appear inside every fence.
 *
 * The configuration is written as `/etc/ssh/ssh_config` itself rather than as a drop-in under
 * `ssh_config.d`, because a drop-in is only read when the host's own main configuration happens to carry
 * an `Include` line for it. Debian's does; that is not a thing to depend on for whether a fence checks
 * host keys. `/etc/ssh` is replaced by an empty tmpfs first (see `fencePlan`), which both makes room for
 * these two to be mounted -- `/etc` is bound read-only, so bubblewrap cannot create a mount point inside
 * it -- and leaves the fence with exactly the client configuration written here and no host defaults
 * underneath it.
 */
export const FENCE_SSH_DIR = "/etc/ssh";
export const FENCE_SSH_AUTH_SOCK = "/run/thetis/ssh-agent.sock";
export const FENCE_SSH_CONFIG = "/etc/ssh/ssh_config";
export const FENCE_SSH_KNOWN_HOSTS = "/etc/ssh/ssh_known_hosts";

/** What the fence is given: the socket to talk to, and the two files that make ssh behave non-interactively. */
export interface FenceSsh {
  sock: string;
  config: string;
  knownHosts: string;
}

export interface SshAgent extends FenceSsh {
  pid: number;
  stop(): void;
}

/**
 * The client options bound over the fence's ssh configuration.
 *
 * `BatchMode` and the two short timeouts are the difference between an error and a hang: without them a
 * missing credential or an unknown host waits on a prompt nobody can answer, and the fence's request timer
 * runs out instead, which reads as "ssh is broken" rather than "this fence has no key for that host".
 * No `IdentitiesOnly`: it would restrict ssh to the identities named by `IdentityFile`, and a fence names
 * none, so the keys the agent holds would never be offered at all and every far end would refuse the
 * fence while `ssh-add -l` showed the key loaded. The agent holds only the granted keys, so there is no
 * walk through unrelated identities to prevent.
 * Host keys: the lines the operator vouched for are the global file, read-only; a host met for the first
 * time is accepted and remembered in the workspace's own `.ssh/known_hosts` under its home (`accept-new`;
 * the path is written out in full, because `~` inside a fence is not the home for every process that runs
 * there), so a key needs no vouched host to be useful; a host whose key changed is refused either way.
 * `no` would accept a changed key too, which is a downgrade wearing the costume of a fix.
 */
const CLIENT_CONFIG = `# Written by Thetis for this fence. The agent on the other side of IdentityAgent holds the keys.
Host *
  IdentityAgent ${FENCE_SSH_AUTH_SOCK}
  BatchMode yes
  StrictHostKeyChecking accept-new
  GlobalKnownHostsFile ${FENCE_SSH_KNOWN_HOSTS}
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 3
`;

export function hasSshAgent(): boolean {
  return existsSync("/usr/bin/ssh-agent") || existsSync("/bin/ssh-agent");
}

/** Writes the client options and the known hosts the kernel vouches for. Both are bound read-only. */
export function writeSshFiles(dir: string, knownHosts: string, home?: string): FenceSsh {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "ssh_config");
  const hosts = join(dir, "known_hosts");
  // The workspace's own known_hosts, where first-met hosts are remembered: made here, 0700, because ssh
  // creates the file but not the directory when the path is spelled out.
  let own = "";
  if (home) {
    const sshDir = join(home, ".ssh");
    try {
      mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      own = `  UserKnownHostsFile ${join(sshDir, "known_hosts")}\n`;
    } catch {
      /* a home that cannot take the directory: the global file alone, and first-met hosts are not kept */
    }
  }
  writeFileSync(config, CLIENT_CONFIG + own, { mode: 0o644 });
  writeFileSync(hosts, knownHosts.endsWith("\n") || !knownHosts ? knownHosts : `${knownHosts}\n`, { mode: 0o644 });
  return { sock: join(dir, "agent.sock"), config, knownHosts: hosts };
}

/**
 * Starts an agent for one fence and loads the granted keys into it.
 *
 * A key that cannot be loaded is reported and skipped rather than failing the fence: one revoked or
 * passphrase-protected key should not cost a person their whole workspace, and the fence can see what it
 * ended up with. `ssh-add` is given the host path of the key, which is read here, by the kernel, and never
 * bound anywhere the fence can reach.
 */
export function startSshAgent(files: FenceSsh, keys: string[], log: (line: string) => void): SshAgent | undefined {
  if (!hasSshAgent()) {
    log("[fence] ssh: no ssh-agent on this host; the grant is ignored");
    return undefined;
  }
  mkdirSync(dirname(files.sock), { recursive: true });
  rmSync(files.sock, { force: true });
  const child: ChildProcess = spawn("ssh-agent", ["-D", "-a", files.sock], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (d: Buffer) => log(`[fence] ssh-agent: ${d.toString().trim()}`));
  // `-D` keeps the agent in the foreground, so the socket is there once it answers rather than once a
  // daemonising parent has exited. Waiting for the file is the cheapest way to know it is up.
  const ready = waitForSocket(files.sock);
  if (!ready) {
    child.kill("SIGKILL");
    log("[fence] ssh: the agent did not create its socket; the grant is ignored");
    return undefined;
  }
  chmodSync(files.sock, 0o600);
  let loaded = 0;
  for (const key of keys) {
    if (!existsSync(key)) {
      log(`[fence] ssh: ${key} is not on this host; skipped`);
      continue;
    }
    const add = spawnSync("ssh-add", [key], { env: { ...process.env, SSH_AUTH_SOCK: files.sock, DISPLAY: "", SSH_ASKPASS: "/bin/false" }, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    if (add.status === 0) loaded += 1;
    else log(`[fence] ssh: ${key} could not be loaded (${(add.stderr ?? "").trim() || `exit ${add.status}`}); skipped`);
  }
  if (loaded === 0) {
    child.kill("SIGKILL");
    rmSync(files.sock, { force: true });
    log("[fence] ssh: no granted key could be loaded; the fence gets no agent");
    return undefined;
  }
  log(`[fence] ssh: agent holding ${loaded} of ${keys.length} granted key${keys.length === 1 ? "" : "s"}`);
  return {
    ...files,
    pid: child.pid ?? 0,
    stop: () => {
      child.kill("SIGTERM");
      rmSync(files.sock, { force: true });
    },
  };
}

/** The socket appears a moment after the agent starts; 2 seconds is far longer than it has ever taken. */
function waitForSocket(path: string): boolean {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    spawnSync("sleep", ["0.02"]);
  }
  return existsSync(path);
}
