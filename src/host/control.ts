import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where the running kernel listens for the command line. Access is by file permission, like the rest of the data directory. */
export function controlSocketPath(home: string): string {
  return resolve(home, "thetis.sock");
}

/**
 * Where the control token lives: a run directory the service manager guarantees, never the data directory.
 *
 * That it is not the data directory is the whole point. The socket's `0600` defends it against other users
 * and has never defended it against a process running as the same one -- and every fence is one, since the
 * daemon and its fences all run as the unit's `User=`. A secret kept beside the socket would be readable by
 * anything that could reach the socket, so it is kept where no fence can look: bubblewrap gives each fence
 * a fresh `/run`, so the host's is not in any of them, whatever else a fence is granted.
 *
 * **There is deliberately no fallback.** The obvious one, `/run/user/<uid>`, is created by logind for a
 * login session and removed with the last one, unless lingering is enabled -- which it is not here. A
 * daemon holding a token in memory whose file had vanished with a logout would refuse every operator
 * command, `thetis restart` included, and the way out would be a `systemctl restart` at exactly the moment
 * the command line stopped working. That is a worse failure than the one this defends against, so when no
 * guaranteed directory is offered there is no token and the socket behaves as it always did. The feature
 * arms itself on installations whose unit says `RuntimeDirectory=thetis`, and is inert on the rest.
 */
export function controlTokenPath(home: string): string | undefined {
  // `RUNTIME_DIRECTORY` is set by systemd when the unit declares `RuntimeDirectory=`, which makes
  // /run/thetis for the service's lifetime and removes it on stop. `XDG_RUNTIME_DIR` is the same guarantee
  // for a user service.
  const run = process.env.RUNTIME_DIRECTORY?.split(":")[0] || process.env.XDG_RUNTIME_DIR;
  return run ? resolve(run, tokenName(home)) : undefined;
}

/**
 * One token file per data directory, named after it.
 *
 * A single `control.token` in a shared run directory is one file for the whole machine, and a machine can
 * hold more than one daemon: the throwaway ones a person starts beside production for a test all land in
 * `$XDG_RUNTIME_DIR`. Each start overwrote the last, so the one before it was left holding a token nobody
 * could read any more and refused every operator command while still answering `ping` -- a command line
 * that had quietly stopped talking to the daemon it named. Naming the file after the data directory the
 * daemon serves makes them independent, and keeps the secret out of that directory, where a fence could
 * read it.
 */
function tokenName(home: string): string {
  return `control.${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}.token`;
}

/**
 * The token this daemon will require, written fresh on every start so that a token from a dead daemon is
 * never accepted by a live one.
 *
 * Returns undefined when the run directory cannot be used, and the daemon then admits anyone who can open
 * the socket, as it always did. That is deliberate: this is defence in depth behind a `0600` socket and a
 * masked data directory, and an installation without a run directory -- a container, a stripped image, a
 * development box -- should keep working rather than lose its command line to a hardening measure.
 */
export function writeControlToken(home: string, log: (line: string) => void): string | undefined {
  const path = controlTokenPath(home);
  if (!path) {
    log("[control] no RuntimeDirectory for this unit; the control socket admits anyone who can open it (add RuntimeDirectory=thetis to require a token)");
    return undefined;
  }
  try {
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    writeFileSync(path, token, { mode: 0o600 });
    return token;
  } catch (err) {
    log(`[control] no token at ${path} (${(err as Error).message}); the socket admits anyone who can open it`);
    return undefined;
  }
}

/**
 * The running daemon's token, for the command line. Undefined when there is none to read.
 *
 * The command line is not run by systemd, so it never has RUNTIME_DIRECTORY; and in a login session it does
 * have XDG_RUNTIME_DIR, which is where a *user* unit's daemon would have written, not a system unit's. So
 * the system unit's directory is tried first, then the user's: whichever holds a token is the daemon's,
 * and finding neither means this daemon requires none.
 */
export function readControlToken(home: string): string | undefined {
  const dirs = [process.env.RUNTIME_DIRECTORY?.split(":")[0], "/run/thetis", process.env.XDG_RUNTIME_DIR].filter((d): d is string => !!d);
  // This data directory's own file first, everywhere, and only then the shared name a daemon started
  // before this change would have written. Without that fallback, upgrading the packages under a daemon
  // that is still running would take its command line away until somebody restarted it.
  const candidates = [...dirs.map((d) => resolve(d, tokenName(home))), ...dirs.map((d) => resolve(d, "control.token"))];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return readFileSync(path, "utf8").trim() || undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}
