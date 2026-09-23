// How long $THETIS_HOME is allowed to be, how long a user id is allowed to be in it, and where each of
// those two facts is actually known.
//
// Every seam between two of our processes is a unix socket under the data directory, and a unix socket
// path is not a path like any other: it has to fit in `sun_path`, a fixed 108-byte field in
// `struct sockaddr_un`, with room for the terminating NUL. Go one byte over and `bind` fails with
// `EINVAL` -- not `ENAMETOOLONG`, not anything that names a length -- so the daemon died saying
// `listen EINVAL: invalid argument /.../thetis.sock` and read as a bug in the daemon rather than as a
// home that was never going to work. `thetis init` had already accepted the path and exited 0.
//
// The limit is 107 and not 108 on purpose. Node's own `listen` will take a 108-byte path, because libuv
// passes the length and the kernel does not insist on the NUL; but we do not open all of these sockets
// ourselves. `ssh-agent` opens one, through glibc, which copies the path with `strlen` and refuses at
// 108 with `too long for Unix domain socket`. A rule that held for our sockets and not for the agent's
// would be the same failure one layer down, so the rule is the strict one.
//
// The thing to be careful about is that the home does not decide this on its own. The longest sockets
// here are per-person -- `<home>/userspaces/<id>/run/term.sock` is 26 bytes of suffix plus the id -- so
// the answer is a *pair*: a home and an id. A home of 60 bytes is perfectly good for `dev` and hopeless
// for a 32-character id, and refusing it at `init` on the strength of an id nobody has asked for would
// be refusing something that works. So the verdict is split to follow where the fact is known:
//
//   - `homeSocketProblem`  -- the home cannot work for *any* id. Unconditional, so it is a refusal, and
//                             `init` and `serve` both make it.
//   - `homeSocketWarning`  -- the home works, but not for every id the kernel would allow. A note at
//                             `init`, naming the longest id this directory can carry. No verdict.
//   - `userIdProblem`      -- this id does not fit this home. Known only when somebody names an id, so
//                             it is refused at `users.create`, where a shorter one can still be chosen.
import { join } from "node:path";
import { SYSTEM_USER } from "../contracts/index.js";

/** The longest a unix socket path may be, in bytes. See the note above for why it is 107 and not 108. */
export const MAX_SOCKET_PATH = 107;

/** The longest user id `kernel/src/users.ts` will accept: `/^[a-z][a-z0-9-]{0,31}$/`. */
export const MAX_USER_ID = 32;

/** One unix socket the system opens under the data directory. */
export interface HomeSocket {
  /** What it is, in the words a person would use, for the message that names the long one. */
  what: string;
  /** Where it is, for one userspace id. */
  path(home: string, userId: string): string;
}

/**
 * Every unix socket that lives under $THETIS_HOME.
 *
 * Kept as data, and in one place, because both ceilings are properties of this list: adding a socket with
 * a longer suffix silently tightens them for everybody, and the only way that stays honest is for the
 * checks to read the list rather than a constant somebody wrote down once. Nothing below hard-codes which
 * socket is the long one; each message asks the list and names whatever it answers.
 *
 * The in-fence paths are the same paths: `bwrap` binds each userspace root at its own host path, so a
 * gateway binding `run/web.sock` inside the fence and the door connecting to it from the host are
 * spelling the same bytes, and `connect` measures `sun_path` exactly as `bind` does.
 */
export const HOME_SOCKETS: HomeSocket[] = [
  // @thetis/runtime: the operator channel every `thetis` command is a client of.
  { what: "the control socket", path: (home) => join(home, "thetis.sock") },
  // @thetis/runtime/sandbox: the per-fence ssh agent, opened by `ssh-agent` itself, which is the strictest opener here.
  { what: "a fence's ssh agent socket", path: (home, userId) => join(home, "fence-ssh", userId, "agent.sock") },
  // @thetis/gateway-login: one socket, in the system userspace, whose id is fixed. It takes no id, so it is
  // the longest of them for a short id and is what decides whether a home can work at all.
  { what: "the sign-in socket", path: (home) => join(home, "userspaces", SYSTEM_USER, "run", "login.sock") },
  // @thetis/gateway-web: one per person, behind the door.
  { what: "a person's gateway socket", path: (home, userId) => join(home, "userspaces", userId, "run", "web.sock") },
  // @thetis/terminal: one per person, between the service and the tools. The longest suffix of the lot.
  { what: "a person's terminal socket", path: (home, userId) => join(home, "userspaces", userId, "run", "term.sock") },
];

/** How an id that is not one person's is written in a message: a real one there would read as a real person's. */
const USER_ID_LABEL = "<user id>";

export interface LongestSocket {
  what: string;
  /** The path, with `<user id>` where an id would go unless a real one was asked about. */
  path: string;
  /** What that path measures, in bytes. */
  bytes: number;
}

/** The longest socket this home opens for `userId`, as the path it really is. */
export function longestHomeSocket(home: string, userId: string): LongestSocket {
  return longest(home, userId, userId);
}

/**
 * The longest socket this home opens for an id of `length` characters, written with `<user id>` where the
 * id goes. The path shown and the bytes counted come from two different ids on purpose: substituting the
 * label into the finished path would also hit the `u` in `userspaces`.
 */
export function longestForIdLength(home: string, length: number): LongestSocket {
  return longest(home, "u".repeat(length), USER_ID_LABEL);
}

function longest(home: string, measured: string, shown: string): LongestSocket {
  const all = HOME_SOCKETS.map((s) => ({ what: s.what, path: s.path(home, shown), bytes: Buffer.byteLength(s.path(home, measured)) }));
  return all.reduce((most, one) => (one.bytes > most.bytes ? one : most));
}

/**
 * The longest user id this data directory can carry, and 0 when it can carry none.
 *
 * Walked down from the kernel's own maximum rather than solved for, because the socket that is longest
 * changes as the id shortens -- below nine characters the sign-in socket, whose id is the fixed `_system`,
 * overtakes the per-person ones -- and thirty-two string joins are not worth being clever about.
 */
export function maxUserIdLength(home: string): number {
  for (let n = MAX_USER_ID; n >= 1; n--) if (longestForIdLength(home, n).bytes <= MAX_SOCKET_PATH) return n;
  return 0;
}

/**
 * The most a data directory path may measure, in bytes, for ids of `userIdLength` characters. The default
 * is the shortest id there is, which makes it the length past which the home cannot work for anybody.
 *
 * Measured against a probe path rather than computed from a written-down suffix, so that it follows
 * `HOME_SOCKETS` on its own. The probe is a directory and not `/`, because `join` eats the separator next
 * to a trailing slash and the answer would come back one byte generous.
 */
export function maxHomeLength(userIdLength = 1): number {
  const probe = "/probe";
  return MAX_SOCKET_PATH - (longestForIdLength(probe, userIdLength).bytes - Buffer.byteLength(probe));
}

/**
 * Why this home cannot work for anybody at all, or undefined when it can work for somebody.
 *
 * This is the only unconditional fact about a home on its own, so it is the only one worth a refusal. The
 * sentence names what the `EINVAL` did not: which home, which socket, how long it would be, what the limit
 * is, and that the fix is a shorter $THETIS_HOME.
 */
export function homeSocketProblem(home: string): string | undefined {
  if (maxUserIdLength(home) > 0) return undefined;
  const worst = longestForIdLength(home, 1);
  return `THETIS_HOME is too long: ${home} (${Buffer.byteLength(home)} bytes). Even with a one-character user id, ${worst.what}, ${worst.path}, would be ${worst.bytes} bytes, and a unix socket path cannot exceed ${MAX_SOCKET_PATH} bytes. Use a THETIS_HOME of at most ${maxHomeLength()} bytes.`;
}

/**
 * What this home costs a person who has not been created yet, or undefined when it costs them nothing.
 *
 * A note and not a refusal, because nothing is wrong yet: the home serves, and the only consequence is a
 * shorter ceiling on user ids, which `userIdProblem` enforces at the moment an id is actually chosen. It
 * is said at `init` because that is where the path is picked and where it is cheapest to pick another.
 */
export function homeSocketWarning(home: string): string | undefined {
  const fits = maxUserIdLength(home);
  if (fits === 0 || fits >= MAX_USER_ID) return undefined;
  const over = longestForIdLength(home, fits + 1);
  return `note: ${home} allows user ids of at most ${fits} characters; a longer id could not open ${over.what}, ${over.path}, because a unix socket path cannot exceed ${MAX_SOCKET_PATH} bytes. A THETIS_HOME of at most ${maxHomeLength(MAX_USER_ID)} bytes carries every id the kernel allows.`;
}

/**
 * Why this id cannot be used in this home, or undefined when it can.
 *
 * An id longer than the kernel's own maximum is not answered here: that is a malformed id, `users.create`
 * already has a sentence for it, and a second opinion from this file would only take its place.
 */
export function userIdProblem(home: string, userId: string): string | undefined {
  if (userId.length > MAX_USER_ID) return undefined;
  const fits = maxUserIdLength(home);
  if (fits === 0) return homeSocketProblem(home);
  if (userId.length <= fits) return undefined;
  const worst = longestHomeSocket(home, userId);
  return `user id ${userId} is too long for this data directory: ${worst.what}, ${worst.path}, would be ${worst.bytes} bytes, and a unix socket path cannot exceed ${MAX_SOCKET_PATH} bytes. ${home} allows user ids of at most ${fits} characters.`;
}

/** Refuses a home that cannot open its sockets for any user id. Called by `thetis init` and `thetis serve`. */
export function assertHomeFitsSockets(home: string): void {
  const problem = homeSocketProblem(home);
  if (problem) throw new Error(problem);
}

/** Refuses an id whose sockets would not fit this home. Called where a user is admitted, and nowhere earlier. */
export function assertUserIdFitsSockets(home: string, userId: string): void {
  const problem = userIdProblem(home, userId);
  if (problem) throw new Error(problem);
}
