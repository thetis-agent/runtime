# 26 Storage

The service plane keeps its records in a namespaced document store. The kernel holds the interface `StoreDriver` from `@thetis/contracts` and never imports a driver, the way it holds `Fences` and never imports the sandbox. The host loads the driver named by `storage.driver` in the configuration. Package code reaches the same store through `env.storage()`, under a namespace the kernel builds.

## 1. The contract

`packages/contracts/src/storage.ts`:

```ts
interface StoreDriver {
  open(namespace: string, opts?: { private?: boolean }): Store;
  close?(): Promise<void>;
}
interface Store {
  get<T extends object>(key: string): Promise<T | undefined>;
  set(key: string, doc: object): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}
type StoreFactory = (opts: { root: string; log: (line: string) => void }) => StoreDriver | Promise<StoreDriver>;
```

| Term | Rule |
|---|---|
| Namespace | One or more segments joined by `/`. Namespaces nest: `a/b` is beneath `a`. |
| Key | One or more segments joined by `/`. `@thetis/exa` is a legal key. |
| Segment | Matches `^[a-z0-9@_][a-z0-9._@-]{0,127}$`, case-insensitive. Never `.`, `..` or empty. At most 16 segments in an id. `assertStoreId` in `@thetis/lib/store` is the shared check; a driver runs it before an id becomes anything on disk. |
| Document | A JSON object, never an array. Values are strings, finite numbers, booleans, arrays and objects. `null` anywhere is refused, because not every format has one. `assertStoreDoc` in `@thetis/lib/store` is the shared check. |
| `set` | Replaces the whole document atomically. A reader sees the old one or the new one, never a half. |
| `get` | `undefined` for a missing key. |
| `list` | The keys of the namespace, or those starting with `prefix`, in no promised order. |
| `delete` | Idempotent. |
| `clear` | Removes every document of the namespace and of every namespace beneath it. |
| `private` | The namespace is unreadable to anyone but the service plane. A file driver creates it `0700` with files `0600`. Once opened private, a namespace stays private. |

The error code of a refused id or document is `invalid`. A driver that cannot read a document it holds fails with the code `storage`.

## 2. What the service plane stores where

| Namespace | Document | Read by |
|---|---|---|
| `users` | `UserRecord`, keyed by user id. | `UserStore` |
| `auth/credentials` (private) | `{ salt, hash }`, keyed by user id. | `AuthService` |
| `auth/tokens` (private) | `{ user, createdAt }`, keyed by token. | `AuthService` |
| `registry` | `PackageRecord`, keyed by package name. | `PackageRegistry` |
| `mounts` | `{ mounts: [ { path, mode } ] }`, keyed by user id. | `MountStore` |
| `config/system`, `config/users/<user>` | `{ [key]: value }`, keyed by package name. | `LayeredConfig` |
| `secrets/system`, `secrets/users/<user>` (private) | `{ [key]: value }`, keyed by package name. | `LayeredConfig` |
| `userspaces/<user>/<package>/<namespace>` | Whatever the package writes through `env.storage()`. | That package, in that person's fence |

Sessions are not on the store yet: they stay under `userspaces/<user>/sessions` as one JSON file per session (`JsonDirStore`). The journal stays `journal.jsonl`. See [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md).

The five record namespaces are read through a `StoreMirror` (section 6). The configuration layers are read on demand and cached by `LayeredConfig`. A package's namespaces are read on every call.

## 3. The driver is a host-plane package

A storage driver is a package with `"thetis": { "type": "storage", "export": "createStore" }`. It is **chosen, not installed**: `storage.driver` in `thetis.config.json` names it, and the host loads it at start.

- `loadStoreDriver` in `packages/host/src/store.ts` finds the package by name among the shipped packages (`<root>/packages`) and then the promoted ones (`$THETIS_HOME/packages`), checks that its `thetis.type` is `storage`, imports its `main`, and calls the export with `{ root: <home>/store, log }`.
- **The probe.** Before anything depends on the driver, the host opens the namespace `_probe`, writes one document, reads it back, deletes it and clears the namespace. A driver that cannot do this refuses the start with one sentence (`storage driver <name> cannot keep records under <home>/store: ...`). A driver that is not there, or whose type is not `storage`, refuses the start too.
- `PackageManager.install` refuses a package of type `storage` with the code `invalid`: it runs on the host, and a fence has no use for it.
- The marketplace mirror skips a package of type `storage`, so the index never offers one. See [18-marketplace.md](18-marketplace.md) section 3.
- The boundary test allows `store-toml` to import `contracts` and `lib` only. The kernel's tests bind `memoryStore()` from `@thetis/lib/store` to `T.store` instead of loading a driver.

The kernel's `KernelServices.store` is the driver's interface. `createKernel` is asynchronous because loading the driver is an import and opening the records reads every document once.

## 4. `@thetis/store-toml`

The default driver, in `packages/store-toml`. One TOML file per document, so a person can read or fix a record with an editor, and an unchanged document is an unchanged file.

**Layout:** `<root>/<namespace>/<key>.toml`. Every segment becomes a directory; the last key segment becomes the file. The key `@thetis/exa` in the namespace `registry` is `<root>/registry/@thetis/exa.toml`. `clear()` on a namespace removes its directory tree, which is what the contract asks for.

**Writes:** `set` writes `<file>.<pid>.<n>.tmp` next to the file and renames it over the old one. `list` walks the namespace directory and reports `.toml` files only, so a temporary file left by a crash is never a document. A file that does not parse fails with its path and the line.

**Modes:** a shared namespace writes files `0644` in directories made with the process's umask. A private namespace sets every directory on its path under the root to `0700` when it is opened and again for each directory a write creates, and writes files `0600`. A namespace that once held shared files becomes private the first time something opens it that way.

**The codec** (`src/toml.ts`) reads TOML 1.0: tables, arrays of tables, dotted and quoted keys, the four string forms with every escape, integers in every base, floats with `inf` and `nan`, booleans, arrays, inline tables and comments. Its caveats, from the package's README:

- A date-time is kept as the string it was written as. A document has no such type.
- Duplicate keys, redefined tables and extending an inline table are errors that name the line.
- The writer is canonical: keys sorted, scalars first, then every nested object as `[a.b]` and every array of objects as `[[a.b]]`, a string with a newline as a multi-line basic string, a key that is not `^[A-Za-z0-9_-]+$` quoted. An array holding a mix of objects and other values is written inline.
- Integers beyond 2^53 and `-0` are not preserved exactly, because values are JavaScript numbers.

`parse` and `stringify` are exported for anyone who wants the codec on its own. The package has no dependency but `@thetis/contracts` and `@thetis/lib`.

## 5. The conformance suite, and writing another driver

`storeConformance(name, open, close?)` in `@thetis/lib/store-conformance` registers `node:test` cases against a driver. Each case opens a fresh driver so a failed case cannot leak into the next. The cases:

| Case | What it checks |
|---|---|
| A nested document round-trips | Unicode, quotes, integers, negatives, floats, booleans, mixed arrays, arrays of objects, deep objects, empty objects and arrays. |
| A large array round-trips | 10,000 numbers. |
| `list` | Every key, a prefix, a nested key, an unknown prefix. |
| A missing key | `get` is `undefined`; `delete` twice is fine. |
| `clear` | Removes the namespace and those beneath it; a sibling that merely shares the prefix stays. |
| An invalid id | Refused with the code `invalid` by `open`, `get` and `set`, before anything is written. |
| A document shape | `null` at any depth and an array document are refused; nothing is written. |
| A private namespace | Every directory `0700`, every file `0600`. Runs only for a driver that exposes `root` as a string; skipped otherwise. |
| Concurrent writes | Fifty `set` calls on one key end with one of the fifty documents, and the key is listed once. |
| A key with a slash | `@thetis/exa` is set, listed under `@thetis/`, and deleted. |

A driver passes this or it is not a driver. To write one:

1. Implement `StoreDriver` from `@thetis/contracts`. Run every id through `assertStoreId` and every document through `assertStoreDoc` from `@thetis/lib/store` (pass `Infinity` as the size cap: the kernel caps what a fence sends).
2. Declare `"thetis": { "type": "storage", "export": "createStore" }` in `package.json`. Export `createStore` as a `StoreFactory`.
3. Register the suite in a test:
   ```ts
   import { storeConformance } from "@thetis/lib/store-conformance";
   storeConformance("mine", async () => createStore({ root, log }));
   ```
4. Put the package in `<root>/packages` or promote it, and set `storage.driver` to its name. Restart the daemon.

The planned next driver is sqlite on `node:sqlite`: one database, one table, the same suite.

## 6. `StoreMirror`: why the kernel records stay synchronous

`users.authorize`, `registry.get`, `auth.authenticate` and `mounts.get` are called synchronously everywhere: at the head of every RPC and control call, in `SessionApi.create`, in `seedSystem`. A store is asynchronous. `StoreMirror<T>` in `@thetis/lib/store` bridges the two:

- `StoreMirror.open(store)` lists the namespace and reads every document once.
- `get`, `has`, `keys`, `all` answer from memory.
- `set` and `delete` change the map now and queue the write to the driver behind the one before it, so the store sees them in the order they were made. The document is copied on `set`, so a later change to it does not reach the write.
- A failed write is reported to `stderr`, not thrown: the map is already the truth the process runs on.
- `flush()` resolves once every queued write has reached the store. `Kernel.shutdown` flushes the five mirrors and then closes the driver.

The semantics equal the read-once JSON files the records were before. `openRecords` in `packages/host/src/store.ts` opens the five mirrors; the token `T.records` holds them.

## 7. `env.storage()` for packages

A step, a tool or a service calls `env.storage(namespace?)` and gets a `Store`. The kernel builds the namespace: `userspaces/<fence user>/<package>/<namespace>`, with `namespace` defaulting to `default`. The fence names only the package and the tail; the prefix is the kernel's, so nothing a fence sends can leave its own tree.

| Rule | Detail |
|---|---|
| Identity | The fence's own user. Another person's fence reads nothing there. |
| The package | The one whose code is running. The userspace agent binds `storage` to the package for each step, tool and service it runs (`buildEnvFor` in `packages/userspace-agent/src/env.ts`). A use of the base environment's `storage` throws `storage() needs the package that runs`. |
| Size | A document from a fence is capped at 256 KiB (`assertStoreDoc` in `rpc.ts`). There is no total quota. |
| `delete_package` | Clears `userspaces/<user>/<package>` and the person's configuration layer for the package. `uninstall` keeps both. |
| `removeUser` | Clears `userspaces/<user>` and both of the person's configuration namespaces. |
| Wire | The five methods are `store.get`, `store.set`, `store.delete`, `store.list`, `store.clear` over the fence RPC ([03-fence.md](03-fence.md) section 6). A missing document travels as `null` and arrives as `undefined`. |

**Known limitation:** a UI command's `env.storage()` is the web gateway's namespace, not the command package's. The gateway hands a command the `StepEnv` its own service was started with, and `storage` in it is bound to `@thetis/gateway-web`. A UI command that needs its own documents should call a tool or a service of its package, or wait for the fix in [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md).

## 8. `thetis migrate`

The four record files that existed before the store (`users.json`, `auth.json`, `registry.json`, `mounts.json`) are imported by `migrateStore` in `packages/host/src/migrate.ts`:

1. The driver is loaded as at start, probe included.
2. Each file that exists is read and its records written into the namespaces of section 2 (`auth.json` into `auth/credentials` and `auth/tokens`, both private; `mounts.json` into `mounts`, one document per user with a non-empty list).
3. The file is renamed `<file>.migrated`.

`assertMigrated(home)` runs at the head of `createKernel`: while any of the four files is still in the home, the daemon refuses to start and names the command. Importing silently at boot would make two copies of the truth. The command refuses to run while a daemon answers the socket, because a daemon holds the records in memory. A second run finds no file and imports nothing.

`deploy/relocate-zero.sh` moves a production data directory to a new home and runs `thetis migrate` in the same downtime. See [08-cli.md](08-cli.md) section 2.16.
