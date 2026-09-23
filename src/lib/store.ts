import type { Store, StoreDriver, StoreOpenOptions } from "../contracts/index.js";
import { assert, errorMessage } from "./error.js";

/** One segment of a namespace or key. A package name (`@thetis/exa`) and a hex token pass; `.`, `..` and the empty segment do not. */
export const STORE_SEGMENT = /^[a-z0-9@_][a-z0-9._@-]{0,127}$/i;

const MAX_SEGMENTS = 16;

/** The shared id check every driver runs before an id becomes anything on disk. Throws with code "invalid". */
export function assertStoreId(id: string): void {
  assert(typeof id === "string" && id.length > 0, "a store id is a non-empty string", "invalid");
  const parts = id.split("/");
  assert(parts.length <= MAX_SEGMENTS, `invalid store id: ${id} (at most ${MAX_SEGMENTS} segments)`, "invalid");
  for (const part of parts) {
    assert(STORE_SEGMENT.test(part), `invalid store id: ${id} (segment ${JSON.stringify(part)})`, "invalid");
  }
}

/** Joins the parts with `/` and checks the result, so a caller-supplied part can never leave its namespace. */
export function storeId(...parts: string[]): string {
  const id = parts.join("/");
  assertStoreId(id);
  return id;
}

/**
 * A document is a JSON object: not an array, and with no `null` or `undefined` anywhere, because not every
 * format has one. The size cap is for documents that come from a fence; a driver passes `Infinity`.
 */
export function assertStoreDoc(doc: unknown, maxBytes = 256 * 1024): asserts doc is Record<string, unknown> {
  assert(isPlainObject(doc), "a document is a JSON object", "invalid");
  assertJsonValue(doc, "doc");
  if (Number.isFinite(maxBytes)) {
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    assert(bytes <= maxBytes, `document is ${bytes} bytes; the limit is ${maxBytes}`, "invalid");
  }
}

/** Refuses anything JSON would not keep as written: null, undefined, functions, non-finite numbers. `path` names where. */
export function assertJsonValue(value: unknown, path: string): void {
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} is not a finite number`, "invalid");
    return;
  }
  assert(value !== null && value !== undefined, `${path} is ${value === null ? "null" : "undefined"}; a document holds no null`, "invalid");
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, `${path}[${i}]`));
    return;
  }
  assert(isPlainObject(value), `${path} is not a JSON value`, "invalid");
  for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Map-backed driver for tests and the bench. Documents are copied in and out, so a caller cannot reach the stored one. */
export function memoryStore(): StoreDriver {
  const spaces = new Map<string, Map<string, Record<string, unknown>>>();
  const space = (ns: string): Map<string, Record<string, unknown>> => {
    let m = spaces.get(ns);
    if (!m) spaces.set(ns, (m = new Map()));
    return m;
  };
  return {
    open(namespace: string, _opts?: StoreOpenOptions): Store {
      assertStoreId(namespace);
      return {
        async get<T extends object = Record<string, unknown>>(key: string): Promise<T | undefined> {
          assertStoreId(key);
          const doc = space(namespace).get(key);
          return doc === undefined ? undefined : (structuredClone(doc) as T);
        },
        async set(key: string, doc: object): Promise<void> {
          assertStoreId(key);
          assertStoreDoc(doc, Infinity);
          space(namespace).set(key, structuredClone(doc));
        },
        async delete(key: string): Promise<void> {
          assertStoreId(key);
          space(namespace).delete(key);
        },
        async list(prefix = ""): Promise<string[]> {
          return [...space(namespace).keys()].filter((k) => k.startsWith(prefix));
        },
        async clear(): Promise<void> {
          for (const ns of [...spaces.keys()]) {
            if (ns === namespace || ns.startsWith(namespace + "/")) spaces.delete(ns);
          }
        },
      };
    },
  };
}

/**
 * One namespace held in memory and written through. Reads are synchronous against the map; every write is
 * queued behind the one before it, so the store sees them in the order they were made. A failed write is
 * reported, not thrown: the map is already the truth the process runs on.
 */
export class StoreMirror<T extends object> {
  private readonly map = new Map<string, T>();
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: Store,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Lists the namespace and reads every document once. */
  static async open<T extends object>(store: Store, onError: (err: unknown) => void = reportWriteError): Promise<StoreMirror<T>> {
    const mirror = new StoreMirror<T>(store, onError);
    for (const key of await store.list()) {
      const doc = await store.get<T>(key);
      if (doc !== undefined) mirror.map.set(key, doc);
    }
    return mirror;
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  keys(prefix = ""): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }

  all(): [string, T][] {
    return [...this.map.entries()];
  }

  /** The map changes now; the store write is queued. The document is copied so a later change to it does not reach the write. */
  set(key: string, doc: T): void {
    const copy = structuredClone(doc);
    this.map.set(key, copy);
    this.enqueue(() => this.store.set(key, copy));
  }

  delete(key: string): void {
    this.map.delete(key);
    this.enqueue(() => this.store.delete(key));
  }

  /** Resolves once every write queued so far has reached the store. The host calls it on shutdown. */
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(write: () => Promise<void>): void {
    this.queue = this.queue.then(write).catch((err) => this.onError(err));
  }
}

function reportWriteError(err: unknown): void {
  process.stderr.write(`[store] write failed: ${errorMessage(err)}\n`);
}
