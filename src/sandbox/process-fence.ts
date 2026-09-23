import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import type { Fence, FenceHandle, KernelRpc, Userspace } from "../contracts/index.js";
import { CodedError, errorMessage } from "../lib/error.js";
import { knownHostsOf } from "../lib/ssh.js";
import { bwrapArgs, hasBwrap, hasCgroupNamespace, launcherCommand, launcherReady, presentMounts } from "./bwrap.js";
import type { Cgroups, FenceCgroup, FenceLimits } from "./cgroup.js";
import { dockerSocket, FENCE_DOCKER_SOCKET, type DockerAccess } from "./docker.js";
import { heartbeatFor, ProcessHandle, type SandboxHandle } from "./handle.js";
import { hasSlirp, startEgress, writeResolvConf } from "./network.js";
import { FENCE_SSH_AUTH_SOCK, startSshAgent, writeSshFiles, type SshAgent } from "./ssh.js";

export type SandboxMode = "auto" | "bwrap" | "none";
export type FenceNetwork = "auto" | "egress" | "none" | "host";

/**
 * The settings a fence is built from, read again on every open rather than resolved once.
 *
 * The kernel passes its own `config.fence` object here, by reference, so a configuration reload that
 * writes into that object in place reaches the next fence to open with nothing else to wire. That is what
 * makes these keys live: closing a person's fence is then enough to put a new network mode, memory limit
 * or Docker setting into service, exactly as it already was for their mounts.
 */
export interface FenceSettings {
  sandbox: SandboxMode;
  /** `egress`: a private network namespace with outbound NAT and no host loopback. `none`: no network. `host`: the host's namespace. */
  network: FenceNetwork;
  /** Whether every fence gets the host's Docker socket. `auto` binds one when the kernel can use it. */
  docker: DockerAccess;
  /** The host socket to bind, when it is not in one of the usual places. */
  dockerSocket?: string;
  limits: FenceLimits;
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
}

/** What one open was built from: the modes as they were when that fence started. */
interface Resolved {
  sandbox: "bwrap" | "none";
  network: "egress" | "none" | "host";
  docker?: string;
}

export interface ProcessFenceOptions {
  agentPath: string;
  /** Read on every open. The kernel's own `config.fence`, so a reload that writes it in place is seen here. */
  fence: FenceSettings;
  /** Writable for the system userspace, read-only for every other fence. */
  sharedDir: string;
  /** Where to write the resolver file bound over /etc/resolv.conf in egress mode. */
  resolvConf: string;
  /** Where the per-fence ssh agent socket and its client files are written. One directory per user beneath it. */
  sshDir: string;
  /** Resolved on the first sandboxed open, so a one-shot command that opens no fence never probes the cgroup. */
  cgroups?: () => Cgroups | undefined;
  /** Read when a fence opens, not when the pool is built, so a reload reaches the next fence to open. */
  requestTimeoutMs: () => number;
  log?: (line: string) => void;
}

/**
 * Runs one long-lived agent process per userspace. With bubblewrap available the agent
 * gets its own PID/IPC/UTS namespaces, a read-only view of the host, and a writable bind
 * of its userspace only. Protocol: newline-delimited JSON over stdio.
 */
export class ProcessFence implements Fence {
  private readonly log: (line: string) => void;
  /** Answered on the first sandboxed open with a cgroup, and remembered: it costs a bubblewrap run. */
  private namespaced?: boolean;
  /** The host probes, which are facts about the machine and not settings: asked once, each costing a process. */
  private bwrapped?: boolean;
  private slirped?: boolean;
  /** What was said about Docker last, so a reload that changes nothing does not repeat itself every open. */
  private said?: string;

  constructor(private readonly opts: ProcessFenceOptions) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * The modes for the fence about to open, from the settings as they are now. Only the host probes are
   * remembered; every configured value is read again, so a reload that rewrites `config.fence` in place is
   * in force for the next fence that opens. The resolver file is written here for the same reason: the
   * network mode may not have been `egress` when the kernel started.
   */
  private resolved(): Resolved {
    const f = this.opts.fence;
    const sandbox = f.sandbox === "auto" ? ((this.bwrapped ??= hasBwrap()) ? "bwrap" : "none") : f.sandbox;
    const network = sandbox === "none" || f.network === "host" ? "host" : f.network === "auto" ? ((this.slirped ??= hasSlirp()) ? "egress" : "host") : f.network;
    if (network === "egress") writeResolvConf(this.opts.resolvConf);
    // In mode `none` the agent runs as the host user and already reaches the host's socket at its own path;
    // there is nothing to bind and nothing to report.
    const docker = sandbox === "bwrap" ? dockerSocket(f.docker, f.dockerSocket, this.log) : undefined;
    // Said once per distinct answer rather than once per open, so a busy installation is not narrated at.
    const say = `${docker ?? "none"}|${network}`;
    if (docker && this.said !== say) {
      this.log(`[fence] docker: ${docker} is bound into every fence (socket access is host root)`);
      // Worth saying, because the failure it predicts looks like a broken stack rather than a fence rule:
      // egress mode has no route to the host's loopback, so a container that publishes a port there — the
      // default for `network_mode: host` with a loopback bind address — is unreachable from the fence that
      // started it. The fence can still reach a container on a bridge network by its address.
      if (network === "egress") this.log('[fence] docker: containers listening on the host\'s loopback cannot be reached from network mode "egress"; set fence.network to "host" to reach them');
    }
    this.said = say;
    return { sandbox, network, docker };
  }

  get mode(): "bwrap" | "none" {
    return this.resolved().sandbox;
  }

  get networkMode(): "egress" | "none" | "host" {
    return this.resolved().network;
  }

  /** The host's Docker socket every fence is given, or undefined when no fence has Docker. */
  get dockerMode(): string | undefined {
    return this.resolved().docker;
  }

  /**
   * The agent starts behind a launch gate: it is placed in its cgroup and, in egress mode, given its
   * network before its first instruction runs. A failure before the gate opens kills the process.
   */
  async open(us: Userspace, rpc: KernelRpc): Promise<SandboxHandle> {
    // Read once for this open and used twice, so the agent beats at exactly the rate its handle is expecting
    // even if the configuration is rewritten while the fence is starting.
    const requestTimeoutMs = this.opts.requestTimeoutMs();
    const heartbeatMs = heartbeatFor(requestTimeoutMs);
    // Half the silence a fence is allowed, and the agent bounds its own short operations with it. The two are
    // one number on purpose: the step's own failure must always come first, so what a person is told is which
    // package hung, not that their fence died -- and a fence that beats while a package hangs would otherwise
    // never be ended by anything.
    const stepDeadlineMs = Math.floor(requestTimeoutMs / 2);
    // Stamped before the spawn: this is when the agent reads its modules, and `status` compares it against
    // what is on disk now.
    const openedAt = Date.now();
    // Resolved once here and passed down, so one fence is built from one consistent answer even if the
    // configuration is rewritten while it is opening.
    const at = this.resolved();
    // The cgroup is adopted before the first child exists: enabling controllers needs the parent group empty.
    const cgroups = at.sandbox === "bwrap" ? this.opts.cgroups?.() : undefined;
    // The fence reads its own limits under /sys/fs/cgroup: at the mount root when it gets a cgroup
    // namespace, at the path /proc/self/cgroup names when it cannot. `openGate` creates that directory
    // before it opens the gate, so it is there by the time bubblewrap execs, and puts the process in it
    // before bubblewrap unshares, so the namespace is rooted at the fence's own group. When limits are off
    // there is no directory to name and no namespace to take.
    // The agent is started before bubblewrap, because its socket is one of the paths bound into the fence.
    // It is a kernel-owned child like the egress helper: the fence talks to it, never holds what it holds.
    const ssh = at.sandbox === "bwrap" ? this.openSsh(us) : undefined;
    const child = this.spawn(us, at, cgroups && cgroups.fence(us.id, this.cgroupNamespace()), ssh, heartbeatMs, stepDeadlineMs);
    const cleanup: (() => void)[] = ssh ? [ssh.stop] : [];
    try {
      if (at.sandbox === "bwrap") await this.openGate(us, at, child, cgroups, cleanup, ssh);
    } catch (err) {
      child.kill("SIGKILL");
      for (const fn of cleanup) fn();
      throw new CodedError(`fence for ${us.id} could not start: ${errorMessage(err)}`, "fence");
    }
    const handle = new ProcessHandle(child, us, rpc, { requestTimeoutMs, heartbeatMs, log: this.log }, cleanup);
    await handle.request("ping", {});
    return Object.assign(handle, { openedAt });
  }

  /**
   * Whether this host can give a fence its own cgroup namespace. Probed once, on the first open that has a
   * cgroup to bind — a one-shot command that opens no fence never runs bubblewrap for it — and a `false`
   * only falls back to the older layout, it never fails a fence.
   */
  private cgroupNamespace(): boolean {
    return (this.namespaced ??= hasCgroupNamespace());
  }

  /**
   * This fence's own ssh agent, holding only the keys granted to this person. Undefined when there is no
   * grant, when the host has no `ssh-agent`, or when no granted key could be loaded: a fence without ssh
   * opens exactly as it did before, and a credential problem never costs someone their workspace.
   */
  private openSsh(us: Userspace): SshAgent | undefined {
    const grants = us.ssh ?? [];
    if (!grants.length) return undefined;
    const files = writeSshFiles(join(this.opts.sshDir, us.id), knownHostsOf(grants), us.home);
    return startSshAgent(files, grants.map((g) => g.key), this.log);
  }

  private async openGate(us: Userspace, at: Resolved, child: ChildProcess, cgroups: Cgroups | undefined, cleanup: (() => void)[], ssh?: SshAgent): Promise<void> {
    await launcherReady(child);
    const pid = child.pid ?? 0;
    const placement = cgroups?.place(us.id, this.opts.fence.limits);
    if (placement) {
      placement.attach(pid);
      cleanup.push(placement.release);
    }
    if (at.network === "egress") {
      const egress = await startEgress(pid, this.log);
      placement?.attach(egress.pid);
      cleanup.push(egress.stop);
    }
    // The agent belongs to this fence, so it is accounted to this fence, exactly as the egress helper is.
    if (ssh && placement) placement.attach(ssh.pid);
    (child.stdio as unknown as (Writable | null)[])[5]?.end("go\n");
    this.log(`[fence] ${us.id}: started (network ${at.network}${placement ? ", limited" : ""}${at.docker ? ", docker" : ""}${ssh ? ", ssh" : ""})`);
  }

  private spawn(space: Userspace, at: Resolved, cgroup?: FenceCgroup, ssh?: SshAgent, heartbeatMs?: number, stepDeadlineMs?: number): ChildProcess {
    // Package code learns the mounts from the environment in every mode; without a sandbox they are simply the host's paths.
    const us = { ...space, mounts: presentMounts(space, this.log) };
    const env = {
      PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
      HOME: us.home,
      LANG: process.env.LANG ?? "C.UTF-8",
      THETIS_USERSPACE: us.root,
      THETIS_HOME_DIR: us.home,
      THETIS_STORE: us.store,
      THETIS_SHARED: this.opts.sharedDir,
      THETIS_USER: us.id,
      THETIS_MOUNTS: JSON.stringify(us.mounts),
      // How often the agent reports itself alive while it is working. It is the kernel's number, not the
      // agent's, because it is the kernel that decides how much silence means death: the two must agree, or
      // a healthy fence beating slower than it is waited for is killed for being busy.
      ...(heartbeatMs ? { THETIS_HEARTBEAT_MS: String(heartbeatMs) } : {}),
      // How long the agent gives an operation that is not the model loop before it stops it and says which
      // package hung. Derived from the same number as the heartbeat, for the reason given where it is computed.
      ...(stepDeadlineMs ? { THETIS_STEP_DEADLINE_MS: String(stepDeadlineMs) } : {}),
      // Set only when the socket is really bound, so a tool asks the environment what this fence has rather
      // than probing a path and guessing why it is missing — the same reason `THETIS_MOUNTS` reports the
      // mounts that were bound and not the ones that were asked for.
      ...(at.docker ? { THETIS_DOCKER: FENCE_DOCKER_SOCKET } : {}),
      // Set only when an agent is really running with a key in it, for the same reason as the two above:
      // the fence asks what it has rather than probing a path and guessing why a connection was refused.
      // `SSH_AUTH_SOCK` is what ssh itself reads; `THETIS_SSH` is what a tool or a skill checks.
      ...(ssh ? { SSH_AUTH_SOCK: FENCE_SSH_AUTH_SOCK, THETIS_SSH: FENCE_SSH_AUTH_SOCK } : {}),
    };
    const node = [process.execPath, this.opts.agentPath];
    if (at.sandbox === "none") {
      return spawn(node[0], node.slice(1), { cwd: us.home, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    const layout = { ...this.opts.fence, network: at.network, cgroup, dockerSocket: at.docker, ssh, sharedDir: this.opts.sharedDir, resolvConf: this.opts.resolvConf };
    const cmd = launcherCommand(["bwrap", ...bwrapArgs(us, layout, env, this.log), "--", ...node], at.network);
    // fds 3 and 4 are unused; 5 is the launch gate (written by us), 6 the ready signal (written by the launcher).
    return spawn(cmd[0], cmd.slice(1), { env, stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"] });
  }
}
