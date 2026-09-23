// The command line finds the daemon's token where the unit put it: a system unit's RuntimeDirectory first,
// then a user session's XDG_RUNTIME_DIR, which a login session sets whether or not the daemon runs there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { controlTokenPath, readControlToken } from "../../src/host/control.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const HOME_A = "/srv/thetis/a";
const HOME_B = "/srv/thetis/b";
const nameFor = (home: string): string => basename(controlTokenPath(home)!);

test("the token is read from the unit's run directory before the login session's", () => {
  const unit = mkdtempSync(join(tmpdir(), "thetis-run-"));
  const session = mkdtempSync(join(tmpdir(), "thetis-xdg-"));
  try {
    const read = (home: string) => () => readControlToken(home);
    writeFileSync(join(session, nameFor(HOME_A)), "from-the-session\n");
    // A login session alone: the session's directory is the only candidate that holds a token.
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: session }, read(HOME_A)), "from-the-session");
    // The daemon's own directory wins when it holds one, whatever the session says.
    writeFileSync(join(unit, nameFor(HOME_A)), "from-the-unit\n");
    assert.equal(withEnv({ RUNTIME_DIRECTORY: unit, XDG_RUNTIME_DIR: session }, read(HOME_A)), "from-the-unit");
    // Nothing anywhere: this daemon requires no token.
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: join(session, "nope") }, read(HOME_A)), undefined);
  } finally {
    rmSync(unit, { recursive: true, force: true });
    rmSync(session, { recursive: true, force: true });
  }
});

test("two daemons on one machine do not take each other's token, and a daemon from before this still works", () => {
  // The throwaway daemons started beside production for a test all share one run directory. With one file
  // for the machine, each start overwrote the last, and the daemon before it went on answering `ping` while
  // refusing every operator command -- a command line that had quietly stopped talking to what it named.
  const session = mkdtempSync(join(tmpdir(), "thetis-xdg-"));
  try {
    assert.notEqual(nameFor(HOME_A), nameFor(HOME_B), "the file is named after the data directory it serves");
    writeFileSync(join(session, nameFor(HOME_A)), "token-a\n");
    writeFileSync(join(session, nameFor(HOME_B)), "token-b\n");
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: session }, () => readControlToken(HOME_A)), "token-a");
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: session }, () => readControlToken(HOME_B)), "token-b");

    // A daemon started before this change wrote the shared name. Upgrading the packages under it must not
    // take its command line away, so that name is still read when this data directory has no file of its own.
    const legacy = mkdtempSync(join(tmpdir(), "thetis-xdg-"));
    writeFileSync(join(legacy, "control.token"), "from-before\n");
    assert.equal(withEnv({ RUNTIME_DIRECTORY: undefined, XDG_RUNTIME_DIR: legacy }, () => readControlToken(HOME_A)), "from-before");
    rmSync(legacy, { recursive: true, force: true });
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
});
