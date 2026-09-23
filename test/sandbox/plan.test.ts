// The mount plan: the ordering rule, what it makes impossible, and that a real bubblewrap agrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "../../src/contracts/index.js";
import { bwrapArgs, fencePlan, hasBwrap, type BwrapLayout } from "../../src/sandbox/bwrap.js";
import { orderIntents, renderIntents, resolveGrants, validateIntents, type MountIntent } from "../../src/sandbox/plan.js";

function space(root: string, mounts: Userspace["mounts"] = []): Userspace {
  return { id: "alice", root, home: join(root, "home"), store: join(root, "store"), run: join(root, "run"), mounts } as unknown as Userspace;
}
const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };

test("the plan is ordered parents first, so no entry can land on top of another", () => {
  const intents: MountIntent[] = [
    { kind: "tmpfs", target: "/opt/zero/data", why: "fence.hidden" },
    { kind: "ro", target: "/opt/zero/data/packages", source: "/opt/zero/data/packages", why: "promoted packages" },
    { kind: "ro", target: "/opt", source: "/opt", why: "the operating system" },
  ];
  assert.deepEqual(orderIntents(intents).map((i) => i.target), ["/opt", "/opt/zero/data", "/opt/zero/data/packages"]);
});

test("entries of equal depth keep the order they were declared, so a mount beats a read-only bind", () => {
  // Mounts are declared last for exactly this reason: same path, same depth, and the later one wins.
  const ordered = orderIntents([
    { kind: "ro", target: "/srv/code", source: "/srv/code", why: "the operating system" },
    { kind: "rw", target: "/srv/code", source: "/srv/code", why: "a rw mount" },
  ]);
  assert.deepEqual(ordered.map((i) => i.kind), ["ro", "rw"]);
});

test("a mask under a bound parent, and a bind under a mask, both survive the ordering", () => {
  // This is the regression. `fence.hidden` masked $THETIS_HOME with a tmpfs, the mask was written before
  // the read-only binds, and when the data directory moved under /opt the later `--ro-bind /opt /opt`
  // landed on top of it. Every fence could then read the journal, the password file and every other
  // userspace, and connect to the control socket. Nothing failed and no test broke.
  const args = renderIntents(orderIntents([
    { kind: "ro", target: "/opt", source: "/opt", why: "the operating system" },
    { kind: "tmpfs", target: "/opt/zero/data", why: "fence.hidden" },
    { kind: "ro", target: "/opt/zero/data/packages", source: "/opt/zero/data/packages", why: "promoted packages" },
  ]));
  const at = (flag: string, target: string) => args.findIndex((x, i) => x === flag && args[i + (flag === "--tmpfs" ? 1 : 2)] === target);
  assert.ok(at("--ro-bind", "/opt") < at("--tmpfs", "/opt/zero/data"), "the mask comes after the parent it hides inside");
  assert.ok(at("--tmpfs", "/opt/zero/data") < at("--ro-bind", "/opt/zero/data/packages"), "a bind inside the mask comes after it");
});

test("two entries claiming one path are reported; a repeat of the same entry is not", () => {
  const clash = validateIntents(orderIntents([
    { kind: "ro", target: "/srv/x", source: "/srv/x", why: "the operating system" },
    { kind: "rw", target: "/srv/x", source: "/srv/x", why: "a rw mount" },
  ]));
  assert.equal(clash.length, 1);
  assert.match(clash[0].message, /only the second one happens/);
  assert.equal(validateIntents(orderIntents([
    { kind: "ro", target: "/srv/x", source: "/srv/x", why: "one" },
    { kind: "ro", target: "/srv/x", source: "/srv/x", why: "two" },
  ])).length, 0, "the same bind twice changes nothing and is not a conflict");
  assert.match(validateIntents([{ kind: "ro", target: "/srv/y", why: "no source" }])[0].message, /names no source/);
});

test("a clean fence plan has no conflicts, and the userspace is writable inside it", () => {
  const plan = orderIntents(fencePlan(space("/srv/thetis/users/alice"), { ...layout, hidden: ["/opt/zero/data"] }));
  assert.deepEqual(validateIntents(plan), []);
  assert.equal(plan.find((i) => i.target === "/srv/thetis/users/alice")?.kind, "rw");
});

test("under a real bubblewrap the mask hides the parent's contents and a bind inside it still shows", { skip: !hasBwrap() }, () => {
  const host = mkdtempSync(join(tmpdir(), "thetis-plan-"));
  const data = join(host, "data");
  const promotedDir = join(data, "packages");
  mkdirSync(promotedDir, { recursive: true });
  writeFileSync(join(host, "beside"), "outside the mask\n");
  writeFileSync(join(data, "secret"), "the service plane\n");
  writeFileSync(join(promotedDir, "promoted"), "a promoted package\n");
  const root = mkdtempSync(join(tmpdir(), "thetis-plan-us-"));
  mkdirSync(join(root, "home"), { recursive: true });

  // `host` stands in for /opt: bound read-only as an ordinary directory, with the data dir masked beneath
  // it and the promoted packages bound back in beneath the mask -- the arrangement the real fence has.
  const args = bwrapArgs(space(root), { ...layout, readOnly: [host, promotedDir], hidden: [data] }, { PATH: "/usr/bin:/bin" });
  const show = `cat ${host}/beside 2>&1 | head -1; cat ${data}/secret 2>&1 | head -1; cat ${promotedDir}/promoted 2>&1 | head -1`;
  const run = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [beside, secret, promoted] = run.stdout.trim().split("\n");
  // The fixture is under /tmp, which the fence replaces with an empty tmpfs, so this line is what proves
  // the parent bind survived that: without it, a hidden `secret` would prove nothing about the mask.
  assert.equal(beside, "outside the mask", "the parent bind has to survive the empty /tmp above it");
  assert.match(secret, /No such file/, `the mask did not apply: the fence read ${JSON.stringify(secret)}`);
  assert.equal(promoted, "a promoted package", "a bind inside the mask has to show through it");
});

test("a read-only bind inside a granted rw mount is bound read-write, so no hole is eaten in the grant", () => {
  // The report: "the agent said the bind was read-only, not read/write like it should have been". A person
  // granted rw over the checkout, and `fence.readOnly` binds `<checkout>/packages` and `<checkout>/node_modules`
  // inside it, so the two directories they most wanted to edit were read-only while everything that reports
  // a mount's mode said rw.
  const resolved = resolveGrants([
    { kind: "ro", target: "/srv/code/packages", source: "/srv/code/packages", why: "the operating system" },
    { kind: "ro", target: "/srv/code/node_modules", source: "/srv/code/node_modules", why: "the operating system" },
    { kind: "rw", target: "/srv/thetis/users/alice", source: "/srv/thetis/users/alice", why: "the userspace" },
    { kind: "rw", target: "/srv/code", source: "/srv/code", grant: true, why: "a rw mount" },
  ]);
  const kindAt = (target: string) => resolved.find((i) => i.target === target)?.kind;
  assert.equal(kindAt("/srv/code"), "rw");
  assert.equal(kindAt("/srv/code/packages"), "rw", "a read-only bind inside the grant takes that subtree back");
  assert.equal(kindAt("/srv/code/node_modules"), "rw");
  assert.match(resolved.find((i) => i.target === "/srv/code/packages")!.why, /read-write inside the mount \/srv\/code/);
});

test("a grant does not reach through a mask, or claim a bind that only passes through it", () => {
  const plan: MountIntent[] = [
    { kind: "rw", target: "/opt/zero", source: "/opt/zero", grant: true, why: "a rw mount" },
    { kind: "tmpfs", target: "/opt/zero/data", why: "fence.hidden" },
    { kind: "ro", target: "/opt/zero/data/packages", source: "/opt/zero/data/packages", why: "promoted packages" },
    { kind: "ro", target: "/opt/zero/data/shared", source: "/opt/zero/data/shared", why: "the shared directory" },
    { kind: "ro", target: "/opt/zero/etc/resolv.conf", source: "/run/thetis/resolv.conf", why: "the egress resolver" },
    { kind: "ro", target: "/elsewhere", source: "/elsewhere", why: "the operating system" },
  ];
  const kinds = Object.fromEntries(resolveGrants(plan).map((i) => [i.target, i.kind]));
  assert.equal(kinds["/opt/zero/data/packages"], "ro", "what shows through a mask is revealed on purpose, read-only");
  assert.equal(kinds["/opt/zero/data/shared"], "ro", "a grant over the parent does not make the shared directory writable");
  assert.equal(kinds["/opt/zero/etc/resolv.conf"], "ro", "a bind of some other host path is not the person's directory");
  assert.equal(kinds["/elsewhere"], "ro", "nothing outside the grant changes");
});

test("a ro mount stays read-only, and so does everything the fence binds inside it", () => {
  const resolved = resolveGrants([
    { kind: "ro", target: "/srv/code/packages", source: "/srv/code/packages", why: "the operating system" },
    { kind: "ro", target: "/srv/code", source: "/srv/code", grant: true, why: "a ro mount" },
  ]);
  assert.equal(resolved.find((i) => i.target === "/srv/code")?.kind, "ro");
  assert.equal(resolved.find((i) => i.target === "/srv/code/packages")?.kind, "ro");
});

test("under a real bubblewrap a granted directory is writable all the way down", { skip: !hasBwrap() }, () => {
  const granted = mkdtempSync(join(tmpdir(), "thetis-grant-"));
  const inner = join(granted, "packages");
  mkdirSync(inner, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "thetis-grant-us-"));
  mkdirSync(join(root, "home"), { recursive: true });
  const args = bwrapArgs(space(root, [{ path: granted, mode: "rw" }]), { ...layout, readOnly: [inner] }, { PATH: "/usr/bin:/bin" });
  const run = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", `touch ${granted}/top 2>&1 && touch ${inner}/deep 2>&1 && echo written`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /written/, `the grant had a read-only hole in it: ${run.stdout}`);
});
