// Git urls as repositories. The normal form decides whether a publish commits in a checkout and whether a
// repository key is offered for a url, so it is wrong in the safe direction or not at all: a spelling it
// cannot place matches nothing but itself. `repoRoute` is what sends one repository through its own ssh
// alias, and the thing to hold it to is that no other repository ever lands on that alias.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHosted, repoKey, repoRoute, sameRepository, slugOfUrl } from "../../src/lib/git-url.js";

test("the ways of writing one github repository are one repository", () => {
  const forms = [
    "git@github.com:thetis-agent/packages.git",
    "https://github.com/thetis-agent/packages.git",
    "https://github.com/thetis-agent/packages",
    "ssh://git@github.com/thetis-agent/packages.git",
    "git+ssh://git@github.com/thetis-agent/packages.git",
    "https://github.com/thetis-agent/packages/",
    "git://github.com/thetis-agent/packages.git",
  ];
  for (const a of forms) for (const b of forms) assert.ok(sameRepository(a, b), `${a} should be ${b}`);
  assert.equal(repoKey(forms[0]), "github.com/thetis-agent/packages");
});

test("a port, a user and a case difference do not make a different repository", () => {
  assert.ok(sameRepository("ssh://git@GitHub.com:22/thetis-agent/packages.git", "https://github.com/Thetis-Agent/packages"));
  assert.ok(sameRepository("https://alice@git.example.com/t/p.git", "git@git.example.com:t/p"));
  assert.ok(sameRepository("ssh://git@git.example.com:2222/t/p.git", "git@git.example.com:t/p.git"));
});

test("different repositories on the same host are different", () => {
  assert.ok(!sameRepository("git@github.com:thetis-agent/packages.git", "git@github.com:thetis-agent/runtime.git"));
  assert.ok(!sameRepository("git@github.com:other/packages.git", "https://github.com/thetis-agent/packages.git"));
  assert.ok(!sameRepository("git@github.com:o/r.git", "git@github.com:o/r-other.git"));
});

test("a host is never the same repository as a local path with the same tail", () => {
  assert.ok(!sameRepository("git@github.com:thetis-agent/packages.git", "/srv/thetis-agent/packages.git"));
  assert.equal(parseHosted("/srv/reg.git"), undefined);
  assert.equal(parseHosted("./reg"), undefined);
  assert.equal(parseHosted("file:///srv/reg.git"), undefined);
});

test("file urls and plain paths are the same local repository", () => {
  assert.ok(sameRepository("file:///srv/reg.git", "/srv/reg"));
  assert.ok(sameRepository("file://localhost/srv/reg.git", "/srv/reg.git"));
  assert.ok(sameRepository("/srv/./reg.git", "/srv/reg"));
  assert.ok(!sameRepository("/srv/reg.git", "/srv/other.git"));
});

test("an empty url matches nothing, itself included", () => {
  assert.ok(!sameRepository("", ""));
  assert.ok(!sameRepository(undefined, null));
  assert.equal(repoRoute(""), undefined);
});

test("a registry or target with no name is named after its url", () => {
  assert.equal(slugOfUrl("git@github.com:thetis-agent/packages.git"), "packages");
  assert.equal(slugOfUrl("file:///srv/team-registry.git"), "team-registry");
});

test("parseHosted takes a url apart: the ssh user is kept, an http user is not, port 22 is no port", () => {
  assert.deepEqual(parseHosted("git@GitHub.com:Thirteen-Games/thetis-packages.git"), { host: "github.com", user: "git", path: "Thirteen-Games/thetis-packages" });
  assert.deepEqual(parseHosted("ssh://deploy@git.example.com:2222/t/p.git/"), { host: "git.example.com", port: 2222, user: "deploy", path: "t/p" });
  assert.deepEqual(parseHosted("ssh://git@github.com:22/o/r.git"), { host: "github.com", user: "git", path: "o/r" });
  assert.deepEqual(parseHosted("https://alice:token@github.com/o/r"), { host: "github.com", user: "git", path: "o/r" });
  assert.equal(parseHosted("https://github.com"), undefined, "a host with no repository is no repository");
  assert.equal(parseHosted("ftp://github.com/o/r"), undefined);
});

test("a route is one alias per repository, whatever spelling it was given in", () => {
  const a = repoRoute("git@github.com:thirteen-games/thetis-packages.git");
  const b = repoRoute("https://github.com/Thirteen-Games/thetis-packages");
  assert.ok(a && b);
  assert.equal(a.alias, b.alias);
  assert.match(a.alias, /^thetis-repo-[0-9a-f]{12}$/);
  assert.notEqual(a.alias, repoRoute("git@github.com:thirteen-games/other.git")?.alias);
  assert.equal(a.host, "github.com");
  assert.equal(a.user, "git");
  assert.equal(a.port, undefined);
  assert.equal(a.url, `ssh://git@${a.alias}/thirteen-games/thetis-packages.git`);
  assert.deepEqual(a.insteadOf, [
    "git@github.com:thirteen-games/thetis-packages.git",
    "ssh://git@github.com/thirteen-games/thetis-packages.git",
    "https://github.com/thirteen-games/thetis-packages.git",
    "git://github.com/thirteen-games/thetis-packages.git",
  ]);
  assert.equal(repoRoute("/srv/reg.git"), undefined, "a local repository needs no key");
});

test("every spelling a route rewrites ends in .git except the configured one, so no prefix reaches another repository", () => {
  const route = repoRoute("git@github.com:o/r.git")!;
  for (const s of route.insteadOf) assert.ok(s.endsWith(".git"), s);
  for (const s of route.insteadOf) assert.ok(!"git@github.com:o/r-other.git".startsWith(s), `${s} would rewrite another repository`);
  // The configured spelling is kept as written, because it is what every pinned source carries.
  assert.equal(repoRoute("https://github.com/o/r")!.insteadOf[0], "https://github.com/o/r");
});

test("a route with a port keeps it, and has no scp spelling, which cannot carry one", () => {
  const route = repoRoute("ssh://git@git.example.com:2222/t/p.git")!;
  assert.equal(route.port, 2222);
  assert.ok(route.insteadOf.every((s) => !/^git@git\.example\.com:/.test(s)));
  assert.ok(route.insteadOf.includes("ssh://git@git.example.com:2222/t/p.git"));
});
