# Runtime module: lib

Mechanism with no policy: ids, JSON files, queues, the container, the journal, the RPC framing, the socket server and client, the unix socket path limit, the userspace layout, package file operations, scrypt, the store checks and mirror, the storage conformance suite, and the configuration layers. Nothing here decides who may do what; the kernel decides, with these parts. The package runs in the host process, where the kernel, the sandbox, the host, and the command line import it, and inside each fence, where the userspace agent imports the RPC framing.

## What it provides

Shared runtime mechanisms. Each module is a subpath export: `import { newId } from "@thetis/runtime/lib/ids"`. There is no root export.

The internal `lib` module depends only on `contracts`; kernel, sandbox and host modules consume its mechanisms. Extensions use the public `@thetis/runtime/lib/*` subpaths. `test/architecture.test.mjs` enforces the internal boundaries.

| Subpath | Content |
|---|---|
| `ids` | `newId(prefix)`, `now()`. |
| `json` | `readJson`, `writeJson` (through a temporary file and a rename), `JsonFile`. |
| `async` | `AsyncQueue`. |
| `error` | `CodedError`, `assert`, `errorMessage`, `errorCode`. |
| `container` | `Container`, `token`. |
| `journal` | `Journal`, `JournalRow`, `JournalFilter`. |
| `json-store` | `JsonDirStore`: one JSON file per record, ids checked before they become paths. |
| `rpc-frames` | `PendingCalls`, `callHandler`, `readFrames`, `encodeFrame`: the `{ id, method, args }` framing. `PendingCalls.alive(id)` delivers a heartbeat -- a frame that carries nothing and settles nothing -- and every frame for a call, heartbeat included, runs its `OpenCall.onLive`, which is where a caller that measures silence resets its clock. It is deliberately not `onEvent`: that one is optional, most callers pass none, and a liveness clock hung off it would never be reset for them. |
| `ndjson-socket` | `RpcSocketServer`, `connectRpcSocket`: the framing over a Unix socket. |
| `socket-paths` | `MAX_SOCKET_PATH`, `MAX_USER_ID`, `HOME_SOCKETS`, `longestHomeSocket`, `longestForIdLength`, `maxUserIdLength`, `maxHomeLength`, `homeSocketProblem`, `homeSocketWarning`, `userIdProblem`, `assertHomeFitsSockets`, `assertUserIdFitsSockets`: how long `$THETIS_HOME` and a user id may be, given every Unix socket that hangs off the home. |
| `userspace-layout` | `UserspaceLayout`: `pathFor`, `exists`, `ensure`, `remove`. |
| `pkg-fs` | `splitSource`, `isGitSource`, `cloneSlugOf`, `cloneDirFor`, `cloneCommand`, `fetchDirFor` and `fetchInto` (a clone the system fence takes for somebody else, under its own store's `fetch/`, copied into their clone directory and removed whether it worked or not -- never through the shared directory, which every fence can read), `buildCommand`, `isInside`, `linkDir`, `removeLink`, `keepOnly`, `copyPackageAs`, `findDependency`, `forkOf` (the fork of a package a userspace already holds, read off the installed records: the fork relation backwards, which is the only way to ask it, since only the fork's own manifest names the other end), `forkVersion`, `forkPackage`, `packagesIn`, `packageDigest`, `samePackage`, and the other package file operations. |
| `git-url` | `repoKey`, `sameRepository`, `slugOfUrl`, `parseHosted`, `repoRoute`: git urls as repositories. `repoKey` is the normal form -- host and path, with the transport, user, port, `.git` and trailing slash taken off -- so `git@github.com:o/r.git` and `https://github.com/o/r` are one repository, and anything it cannot parse matches only itself. `repoRoute` is how the system fence reaches one repository with the key it holds for it: an ssh host alias of its own (`thetis-repo-<12 hex>`), the `ssh://` url through that alias, and the spellings git should rewrite to it. It lives here because three places ask the one question -- `@thetis/package-publish` (is this checkout the registry?), the kernel's installs (does the installation hold a key for this source?) and the fence (which alias does this key get?) -- and two normal forms that disagree would offer a key for a repository the publisher thinks is another. |
| `ssh` | `SshStore` (each person's grants, `repo` included), `knownHostsOf`, `repoGrantFor(grants, url)`: the repository key a grant list holds for a url, matched with `sameRepository`. |
| `crypto` | `randomHex`, `scryptHex`. |
| `freshness` | `newestMtime`. |
| `restart` | `RestartLatch`, `isSupervised`. The latch reads `control` through the configuration reference on each use, so a reloaded `control.*` is what it sees. |
| `store` | `assertStoreId`, `storeId`, `assertStoreDoc`, `assertJsonValue`: the shared checks every driver runs. `memoryStore()`: a Map-backed driver for tests and the bench. `StoreMirror`: one namespace held in memory and written through in order, so the kernel's records stay synchronous; `flush()` on shutdown. |
| `store-conformance` | `storeConformance(name, open, close?)`: the `node:test` cases a storage driver passes. |
| `versions` | `compareVersions(a, b)`, `isNewer(a, b)`: two version strings compared as versions, because `0.10.0` sorts before `0.9.0` as text. It is here rather than beside a caller because it had two homes and they disagreed: `@thetis/marketplace` decides whether a badge says a package is ahead of a registry and `@thetis/package-publish` decides whether the publish is allowed, which is one question asked twice. It is total, so every pair of strings has an order and nothing answers "I cannot say"; deciding what a package *may* be published at is a stricter question and stays with the publisher. |
| `config` | `validateDecls`, `forkChain`, `mergedDecls`, `defaultsOf`, `isSecretKey`, `checkValue`, `mergeDocs`, `findRefs`, `resolveRefs`, `describe`, `changedPackages`, `parseDotEnv`, `EnvFile` (the `.env` file re-read on change, a shell value winning over the file's), `LayeredConfig` (the four layers over a driver in `config/*` and `secrets/*`, layer-major along a fork chain). |

The mount and ssh mechanism that used to be here (`mounts`, `ssh`) is the lib of `@thetis/host-grants`, the host package that answers `host.grants.*`: it needs the host, not the daemon, and moving it out is what made the daemon's last restart the last one.

## Use

The container. `bind` registers a factory; a second `bind` on the same token replaces the first and clears the cached instance. `get` calls the factory on the first call, returns the same instance later, and throws when the token has no binding.

```ts
import { Container, token } from "@thetis/runtime/lib/container";

const Log = token<(line: string) => void>("log");
const c = new Container().bind(Log, () => (line) => process.stderr.write(line + "\n"));
c.get(Log)("hello");
```

The journal. Rows go to `<home>/journal.jsonl`, one JSON object per line; past 16 MiB the file rolls to `journal.1.jsonl`. What goes in a row is the caller's decision.

```ts
import { Journal } from "@thetis/runtime/lib/journal";

const journal = new Journal(home);
journal.append({ kind: "user.create", actor: "operator", target: "alice", data: { role: "user" } });
const rows = journal.tail(20, { kind: "user.create" });
```

The socket client, the way the command line reaches a running kernel. `connectRpcSocket` resolves `undefined` when no socket file exists or nothing listens on it.

```ts
import { connectRpcSocket } from "@thetis/runtime/lib/ndjson-socket";

const remote = await connectRpcSocket(socketPath);
if (remote) {
  const users = await remote.call("users.list", {});
  remote.close();
}
```

The socket path limit. A Unix socket path has to fit in `sun_path`, and the sockets of one installation all hang off `$THETIS_HOME`, so the data directory has a maximum length — but not one length, because the longest of those sockets is per-person: `userspaces/<id>/run/term.sock` is 26 bytes plus the id. A home and an id decide it together, so the module answers three different questions and each caller asks the one it can.

`homeSocketProblem` answers only what is true of a home alone: over **73 bytes** even a one-character id overflows, and that is a refusal `thetis init` and `thetis serve` both make. `homeSocketWarning` answers what a working home costs: over **49 bytes** it cannot carry all 32 characters the kernel allows, which is a note at `init` and no verdict at all. `userIdProblem` answers the pair, at `users.create`, where a shorter id can still be chosen. An id longer than `MAX_USER_ID` is left alone: that is a malformed id and the kernel has its own sentence for it.

```ts
import { assertHomeFitsSockets, assertUserIdFitsSockets, homeSocketWarning, maxUserIdLength } from "@thetis/runtime/lib/socket-paths";

assertHomeFitsSockets(home);            // throws only when no id at all would fit
homeSocketWarning(home);                // a note, or undefined when the home costs nothing
maxUserIdLength("/opt/zero/data");      // 32
assertUserIdFitsSockets(home, id);      // throws with the home, the socket, its length and the limit
```

## Files

| File | Content |
|---|---|
| `ids.ts` | Random ids with a prefix, ISO timestamps. |
| `json.ts` | Atomic JSON file read and write. |
| `async.ts` | An async iterable queue. |
| `error.ts` | Errors with a `code` string. |
| `container.ts` | The inversion-of-control container. |
| `journal.ts` | The append-only record. |
| `json-store.ts` | One JSON file per record. |
| `rpc-frames.ts` | Pending calls, frame encoding, line reading. |
| `ndjson-socket.ts` | The Unix socket server (mode `0600`) and client. |
| `socket-paths.ts` | The `sun_path` limit, the sockets under the data directory, and the two verdicts. |
| `userspace-layout.ts` | The directories of one userspace. |
| `pkg-fs.ts` | Sources, clones, links, copies, forks, and the digest that says whether a fork is still a copy of its origin. |
| `git-url.ts` | The repository normal form and the route to a repository through its key's alias. |
| `ssh.ts` | The per-person grant records, their known hosts, and the repository key for a url. |
| `crypto.ts` | Random hex and scrypt. |
| `freshness.ts` | The newest modification time under a set of directories. |
| `restart.ts` | The restart latch. |
| `store.ts` | Store ids and documents, the memory driver, the mirror. |
| `store-conformance.ts` | The driver test suite. |
| `versions.ts` | The one version comparison, and the rule written out. |
| `config.ts` | Declarations, chains, layers, references, the env file. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suites of this package are under `test/lib/`: `lib.test.ts` (the container, the async queue, package sources, forks both ways -- `forkOf` over the records and the package digest -- `packagesIn` and `keepOnly`, the JSON directory store, the RPC framing, the socket path limit), `store.test.ts` (ids, documents, the memory driver, the mirror), `config.test.ts` (declarations, the fork chain, layer-major merging, references, `describe`, the env file, `LayeredConfig` over `memoryStore()`), `freshness.test.ts` and `restart.test.ts`. To run one alone after `npm run build`: `node --test dist/test/lib/lib.test.js`.
