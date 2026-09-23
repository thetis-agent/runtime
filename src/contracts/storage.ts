// Namespaced document storage: what the service plane keeps its records in, and what package code reaches
// through `env.storage()`. A driver is a host-plane package of type `storage`; the kernel holds only this
// interface and never imports a driver, the way it holds `Fences` and never imports the sandbox.

/** How a namespace is opened. */
export interface StoreOpenOptions {
  /** Kept unreadable to anyone but the service plane: a file driver creates it 0700 with files 0600. */
  private?: boolean;
}

/**
 * One namespace of documents. A document is a JSON object (never an array) whose values are strings,
 * numbers, booleans, arrays and objects; `null` anywhere is refused, because not every format has one.
 * `set` replaces the whole document atomically: a reader sees the old one or the new one, never a half.
 */
export interface Store {
  get<T extends object = Record<string, unknown>>(key: string): Promise<T | undefined>;
  set(key: string, doc: object): Promise<void>;
  delete(key: string): Promise<void>;
  /** The keys of this namespace, optionally those starting with `prefix`, in no promised order. */
  list(prefix?: string): Promise<string[]>;
  /** Removes every document of this namespace and of every namespace beneath it. */
  clear(): Promise<void>;
}

/**
 * Namespaces nest by `/`. A namespace or key is one or more segments; a segment matches
 * `^[a-z0-9@_][a-z0-9._@-]{0,127}$` case-insensitively, so a package name (`@thetis/exa`) and a hex
 * token are legal and `.`, `..` and the empty segment are not. A driver checks ids before they become
 * anything on disk; `assertStoreId` in `@thetis/runtime/lib/store` is the shared check.
 */
export interface StoreDriver {
  open(namespace: string, opts?: StoreOpenOptions): Store;
  close?(): Promise<void>;
}

/** What a `storage` package exports: `createStore`, called once by the host with the store's root directory. */
export type StoreFactory = (opts: { root: string; log: (line: string) => void }) => StoreDriver | Promise<StoreDriver>;

/** The package type of a storage driver. Chosen by `storage.driver` in the configuration; never installed into a fence. */
export const STORAGE_TYPE = "storage";
