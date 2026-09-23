// The per-fence ssh agent: what the fence is given, what it is never given, and that a real agent answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "../../src/contracts/index.js";
import { knownHostsOf } from "../../src/lib/ssh.js";
import { bwrapArgs, fencePlan, hasBwrap, type BwrapLayout } from "../../src/sandbox/bwrap.js";
import { FENCE_SSH_AUTH_SOCK, FENCE_SSH_KNOWN_HOSTS, hasSshAgent, startSshAgent, writeSshFiles } from "../../src/sandbox/ssh.js";

function space(root: string): Userspace {
  return { id: "alice", root, home: join(root, "home"), store: join(root, "store"), run: join(root, "run"), mounts: [] } as unknown as Userspace;
}
const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };
const quiet = () => {};

/** A throwaway key, so no test ever depends on a key the host actually uses. */
function makeKey(dir: string, name = "id_ed25519"): string {
  const path = join(dir, name);
  const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "thetis-test", "-f", path], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);
  return path;
}

test("the fence is given the socket and the client files, and never a key", () => {
  const files = { sock: "/host/agent.sock", config: "/host/ssh_config", knownHosts: "/host/known_hosts" };
  const plan = fencePlan(space("/srv/thetis/users/alice"), { ...layout, ssh: files });
  const targets = plan.map((i) => i.target);
  assert.ok(targets.includes(FENCE_SSH_AUTH_SOCK), `no agent socket in ${targets.join(" ")}`);
  assert.ok(targets.includes(FENCE_SSH_KNOWN_HOSTS));
  // Everything ssh brings in is either an empty tmpfs, which carries no source at all, or a read-only
  // bind of a socket or a text file. None of it is a key: the key is on the kernel's side of the socket,
  // so the fence can ask for a signature and can never ask for the key.
  for (const i of plan.filter((p) => /ssh|known hosts/.test(p.why))) {
    assert.ok(i.kind === "ro" || i.kind === "tmpfs", `${i.target} is ${i.kind}`);
    assert.ok(!/id_|\.pem$|key$/.test(i.source ?? ""), `a key reached the fence: ${i.source}`);
  }
});

test("no grant, no ssh anywhere in the arguments", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), layout, {});
  assert.ok(!args.some((a) => a.includes("ssh")), `the fence was given ssh it has no grant for: ${args.join(" ")}`);
});

test("the client options make ssh fail rather than hang, and keep host checking on", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-ssh-files-"));
  const files = writeSshFiles(dir, "github.com ssh-ed25519 AAAAC3Nz");
  const config = readFileSync(files.config, "utf8");
  // Without BatchMode a missing credential waits on a prompt nobody can answer and the fence's request
  // timer runs out instead, which reads as "ssh is broken" rather than "this fence has no key for that".
  assert.match(config, /BatchMode yes/);
  // IdentitiesOnly would keep ssh to IdentityFile keys, of which a fence has none: the agent's keys would never be offered.
  assert.doesNotMatch(config, /IdentitiesOnly/);
  // `no` would turn a missing known-hosts entry into silent acceptance of any key: a downgrade, not a fix.
  assert.match(config, /StrictHostKeyChecking accept-new/);
  assert.match(config, /GlobalKnownHostsFile \/etc\/ssh\/ssh_known_hosts/);
  assert.doesNotMatch(config, /UserKnownHostsFile/, "without a home there is no user file to remember hosts in");
  const homed = readFileSync(writeSshFiles(join(dir, "homed"), "", join(dir, "home")).config, "utf8");
  assert.ok(homed.includes(`UserKnownHostsFile ${join(dir, "home", ".ssh", "known_hosts")}`), "with a home, first-met hosts are remembered under it");
  assert.equal((statSync(join(dir, "home", ".ssh")).mode & 0o777), 0o700, "the workspace's .ssh is made for ssh, private");
  assert.match(config, new RegExp(`IdentityAgent ${FENCE_SSH_AUTH_SOCK}`));
  assert.equal(readFileSync(files.knownHosts, "utf8"), "github.com ssh-ed25519 AAAAC3Nz\n");
});

// Parsing a grant and reporting a key's presence are the host package's (`@thetis/host-grants`), tested there.
test("the known hosts of every grant are written once each", () => {
  assert.equal(knownHostsOf([{ key: "/k", hosts: ["a", "a"] }, { key: "/other", hosts: ["a", "b"] }]), "a\nb\n");
});

test("a real agent holds the granted key, and the fence can use it without ever seeing it", { skip: !hasSshAgent() || !hasBwrap() }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-ssh-agent-"));
  const key = makeKey(dir);
  const files = writeSshFiles(join(dir, "fence"), "github.com ssh-ed25519 AAAAC3Nz");
  const agent = startSshAgent(files, [key, "/nowhere/missing_key"], quiet);
  assert.ok(agent, "the agent did not start");
  t.after(() => agent.stop());

  // One granted key loaded, the missing one skipped rather than fatal: a revoked key should not cost
  // someone their whole workspace.
  const listed = spawnSync("ssh-add", ["-l"], { env: { ...process.env, SSH_AUTH_SOCK: agent.sock }, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim().split("\n").length, 1, listed.stdout);
  assert.match(listed.stdout, /thetis-test/);

  const root = mkdtempSync(join(tmpdir(), "thetis-ssh-us-"));
  spawnSync("mkdir", ["-p", join(root, "home")]);
  const args = bwrapArgs(space(root), { ...layout, ssh: agent }, { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: FENCE_SSH_AUTH_SOCK });
  // Inside the fence: the agent answers, and the key file itself is not there to be read or copied.
  const show = `ssh-add -l; test -r ${key} && echo "KEY-READABLE" || echo "key-absent"; ssh -G github.com | grep -ci '^batchmode yes'`;
  const run = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /thetis-test/, `the agent did not answer inside the fence: ${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /KEY-READABLE/, `the private key reached the fence: ${run.stdout}`);
  // And ssh really reads the configuration written for this fence, rather than the host's defaults.
  assert.match(run.stdout, /^1$/m, `ssh did not pick up the fence's client options: ${run.stdout}`);
});

test("an agent with no loadable key is no agent at all", { skip: !hasSshAgent() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-ssh-none-"));
  const files = writeSshFiles(join(dir, "fence"), "");
  const lines: string[] = [];
  // A fence with an agent holding nothing would look like ssh works and refuse every connection. Better
  // to have no agent, no SSH_AUTH_SOCK, and a fence that can see it has no credential.
  assert.equal(startSshAgent(files, ["/nowhere/a", "/nowhere/b"], (l) => lines.push(l)), undefined);
  assert.match(lines.join("\n"), /no granted key could be loaded/);
  assert.equal(existsSync(files.sock), false, "the socket is removed with the agent");
});
