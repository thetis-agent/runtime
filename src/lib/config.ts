import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { ConfigDecl, ConfigKeyState, ConfigLayer, ConfigReport, Store, StoreDriver, ThetisField } from "../contracts/index.js";
import { ConfigDeclSchema, ConfigKeySchema, ConfigValueSchemas } from "../contracts/schemas/config.js";
import { assert, CodedError } from "./error.js";
import { assertJsonValue } from "./store.js";
import { parseSchema } from "./validation.js";

export type ConfigDecls = Record<string, ConfigDecl>;

/** One package of a fork chain: its name and what it declares. */
export interface ConfigLink {
  name: string;
  decls: ConfigDecls;
}

/** One document of one layer. `from` is the package name the document belongs to, which for a fork may be an origin. */
export interface ConfigDoc {
  layer: ConfigLayer;
  from: string;
  doc: Record<string, unknown>;
}

const DeclEntriesSchema = z.record(z.string(), z.unknown(), { error: "must be an object of key declarations" });
const SECRET_NAME = /key|secret|token|password/i;
const REF = /\$\{([A-Z0-9_]+)\}/g;
const PURE_REF = /^\$\{[A-Z0-9_]+\}$/;

/** The shape check of a `thetis.config` field. Every complaint names the package and the key, since it is read at package load. */
export function validateDecls(owner: string, raw: unknown): ConfigDecls {
  const where = `${owner}: thetis.config`;
  const entries = parseSchema(DeclEntriesSchema, raw, where);
  const decls: ConfigDecls = {};
  for (const [key, rawDecl] of Object.entries(entries)) {
    const at = `${where}.${key}`;
    parseSchema(ConfigKeySchema, key, at);
    const parsed = ConfigDeclSchema.safeParse(rawDecl);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue.code === "unrecognized_keys" ? `unknown field ${issue.keys.join(", ")}` : issue.message;
      throw new CodedError(`${at}: ${message}`, "invalid");
    }
    const decl = parsed.data;
    if (decl.default !== undefined) {
      try {
        checkValue({ [key]: decl }, key, decl.default);
      } catch (err) {
        throw new CodedError(`${at}: default ${err instanceof Error ? err.message : String(err)}`, "invalid");
      }
      decl.default = structuredClone(decl.default);
    }
    decls[key] = decl;
  }
  return decls;
}

/**
 * The packages a fork inherits configuration from, origin first and the package itself last. Stops at a
 * package it cannot see, at a name it has already visited, and at `limit` links.
 */
export function forkChain(name: string, thetisOf: (name: string) => ThetisField | undefined, limit = 8): ConfigLink[] {
  const chain: ConfigLink[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current && !seen.has(current) && chain.length < limit) {
    seen.add(current);
    const thetis = thetisOf(current);
    chain.unshift({ name: current, decls: thetis?.config ?? {} });
    current = thetis?.forkedFrom?.name;
  }
  return chain;
}

/** One set of declarations for the chain; a fork's declaration of a key replaces its origin's. */
export function mergedDecls(chain: ConfigLink[]): ConfigDecls {
  return Object.assign({}, ...chain.map((link) => link.decls)) as ConfigDecls;
}

export function defaultsOf(decls: ConfigDecls): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(decls)) {
    if (decl.default !== undefined) out[key] = structuredClone(decl.default);
  }
  return out;
}

/** A declared key is what its declaration says. An undeclared one is a secret when its name looks like one. */
export function isSecretKey(decls: ConfigDecls, key: string): boolean {
  const decl = decls[key];
  return decl ? decl.secret === true : SECRET_NAME.test(key);
}

/**
 * What may be stored under a key. `null` is refused everywhere, because the store holds no null. A declared
 * type must match; a `${VAR}` reference is a string, so it fits only a string key.
 */
export function checkValue(decls: ConfigDecls, key: string, value: unknown): void {
  assert(value !== null && value !== undefined, `${key}: a value cannot be null`, "invalid");
  assertJsonValue(value, key);
  const decl = decls[key];
  if (!decl) return;
  assert(ConfigValueSchemas[decl.type].safeParse(value).success, `${key} is declared ${decl.type}; ${describeType(value)} was given`, "invalid");
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * Top-level keys of every document in order; a later document wins a key, and `sources` says which one did.
 * When both hold a plain object under a key, the later one's keys are laid over the earlier one's, one level
 * deep, so a file layer's `embeddings: { baseUrl }` keeps a declared `embeddings.apiKey`; arrays and scalars
 * replace. `sources` is per top-level key and names the last layer that touched it.
 */
export function mergeDocs(docs: ConfigDoc[]): { values: Record<string, unknown>; sources: Record<string, { layer: ConfigLayer; from: string }> } {
  const values: Record<string, unknown> = {};
  const sources: Record<string, { layer: ConfigLayer; from: string }> = {};
  for (const { layer, from, doc } of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const under = values[key];
      values[key] = isPlainObject(under) && isPlainObject(value) ? { ...under, ...value } : value;
      sources[key] = { layer, from };
    }
  }
  return { values, sources };
}

/** Every `${NAME}` in any string leaf, each once, in the order met. */
export function findRefs(value: unknown): string[] {
  const names = new Set<string>();
  walkStrings(value, (s) => {
    for (const m of s.matchAll(REF)) names.add(m[1]);
  });
  return [...names];
}

function walkStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, fn));
  else if (isPlainObject(value)) Object.values(value).forEach((v) => walkStrings(v, fn));
}

/**
 * Replaces every `${NAME}` with its environment value. A leaf holding a name the environment lacks is
 * dropped, never turned into an empty string: a package should see nothing rather than a wrong value.
 * `missing` lists those names under the top-level key that held them.
 */
export function resolveRefs<T>(value: T, env: Record<string, string | undefined>): { value: T; missing: Record<string, string[]> } {
  const missing: Record<string, string[]> = {};
  const note = (top: string, names: string[]) => {
    const list = (missing[top] ??= []);
    for (const n of names) if (!list.includes(n)) list.push(n);
  };
  const resolve = (v: unknown, top: string): { ok: boolean; value?: unknown } => {
    if (typeof v === "string") {
      const lacking = findRefs(v).filter((n) => env[n] === undefined);
      if (lacking.length) {
        note(top, lacking);
        return { ok: false };
      }
      return { ok: true, value: v.replace(REF, (_, n: string) => env[n] as string) };
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) {
        const r = resolve(item, top);
        if (r.ok) out.push(r.value);
      }
      return { ok: true, value: out };
    }
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) {
        const r = resolve(item, top === "" ? k : top);
        if (r.ok) out[k] = r.value;
      }
      return { ok: true, value: out };
    }
    return { ok: true, value: v };
  };
  const r = resolve(value, "");
  return { value: (r.ok ? r.value : undefined) as T, missing };
}

/** The state of every key of one package, from what the chain declares, what the layers hold, and what the environment can resolve. */
export function describe(name: string, chain: ConfigLink[], docs: ConfigDoc[], env: Record<string, string | undefined>, user?: string): ConfigReport {
  const decls = mergedDecls(chain);
  const { values, sources } = mergeDocs(docs);
  const keyNames = [...new Set([...Object.keys(decls), ...Object.keys(values)])];
  const keys: ConfigKeyState[] = keyNames.map((key) => {
    const decl = decls[key];
    const secret = isSecretKey(decls, key);
    const state: ConfigKeyState = { key, state: "unset", secret, declared: decl !== undefined };
    if (decl) {
      state.type = decl.type;
      if (decl.required !== undefined) state.required = decl.required;
      if (decl.scope !== undefined) state.scope = decl.scope;
      if (decl.help !== undefined) state.help = decl.help;
    }
    const raw = values[key];
    if (raw === undefined) {
      if (decl?.required) state.state = "missing";
      return state;
    }
    const { missing } = resolveRefs({ [key]: raw }, env);
    const lacking = missing[key] ?? [];
    state.state = lacking.length ? "missing" : "set";
    if (lacking.length) state.missing = lacking;
    state.source = sources[key].layer;
    if (sources[key].from !== name) state.inheritedFrom = sources[key].from;
    if (secret) {
      if (typeof raw === "string" && PURE_REF.test(raw)) state.value = raw;
      else state.redacted = true;
      return state;
    }
    const shown = display(raw);
    state.value = shown.value;
    if (shown.redacted) state.redacted = true;
    return state;
  });
  const problems: string[] = [];
  for (const k of keys) {
    if (k.state !== "missing") continue;
    if (k.missing) for (const v of k.missing) problems.push(`${k.key}: ${v} is not in the environment`);
    else problems.push(`${k.key} is required and not set`);
  }
  return {
    package: name,
    ...(user !== undefined ? { user } : {}),
    inherits: chain.map((link) => link.name).filter((n) => n !== name),
    keys,
    summary: problems.length ? problems.join("; ") : "every key is set",
    broken: problems.length > 0,
  };
}

/**
 * A stored value as it is shown. A non-secret key can hold a secret inside it (`embeddings.apiKey`), so a
 * string leaf under a secret-looking name is hidden at any depth; a pure reference stays a reference, as
 * for a top-level secret. `redacted` says whether anything was hidden.
 */
function display(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const hide = (v: unknown, k: string): unknown => {
    if (typeof v === "string") {
      if (!SECRET_NAME.test(k) || PURE_REF.test(v)) return v;
      redacted = true;
      return "•••";
    }
    if (Array.isArray(v)) return v.map((item) => hide(item, k));
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([ik, iv]) => [ik, hide(iv, ik)]));
    return v;
  };
  // The top-level key is judged by its declaration, so only nested names go through the regex.
  return { value: hide(value, ""), redacted };
}

/** The package names whose configuration differs between two file layers, on either side. */
export function changedPackages(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => stable(before[n]) !== stable(after[n]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** `NAME=value` lines; one pair of quotes around the value is stripped. The first line naming a variable wins, as the shell loader did. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && out[m[1]] === undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface EnvSource {
  snapshot(): Record<string, string | undefined>;
}

/**
 * The environment as the daemon sees it: the process environment, with the names the `.env` file supplied
 * following the file. Which names those are is decided once, at construction: a name whose process value
 * equals the file's came from the file. A name the shell set to something else keeps the shell's value.
 */
export class EnvFile implements EnvSource {
  private readonly fromFile: Set<string>;
  private values: Record<string, string>;
  private mtime: number;

  constructor(
    private readonly file: string,
    private readonly base: NodeJS.ProcessEnv = process.env,
  ) {
    this.mtime = mtimeOf(file);
    this.values = readDotEnv(file);
    this.fromFile = new Set(Object.keys(this.values).filter((n) => base[n] === this.values[n]));
  }

  snapshot(): Record<string, string | undefined> {
    const mtime = mtimeOf(this.file);
    if (mtime !== this.mtime) {
      this.mtime = mtime;
      this.values = readDotEnv(this.file);
    }
    const out: Record<string, string | undefined> = { ...this.base };
    for (const name of this.fromFile) {
      if (this.values[name] === undefined) delete out[name];
      else out[name] = this.values[name];
    }
    // A name the file gained later and the shell never set is the file's too.
    for (const [name, value] of Object.entries(this.values)) {
      if (this.base[name] === undefined && !this.fromFile.has(name)) out[name] = value;
    }
    return out;
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function readDotEnv(file: string): Record<string, string> {
  return existsSync(file) ? parseDotEnv(readFileSync(file, "utf8")) : {};
}

type Cached = Record<string, unknown> | null;

/**
 * The four stored layers of per-package configuration over one driver. Namespaces: `config/system`,
 * `config/users/<U>`, `secrets/system`, `secrets/users/<U>`; the secrets namespaces are private. One
 * document per package name, `{ [key]: value }`. Documents are cached once read; this class's own writes
 * keep the cache true, and `invalidate` drops it for anything written another way.
 */
export class LayeredConfig {
  private readonly stores = new Map<string, Store>();
  private readonly cache = new Map<string, Map<string, Cached>>();

  constructor(
    private readonly driver: StoreDriver,
    private readonly filePackages: () => Record<string, Record<string, unknown>>,
  ) {}

  /** Layer-major along the chain: every default, then every file, system and user document, origin first within a layer. */
  async docs(chain: ConfigLink[], user?: string): Promise<ConfigDoc[]> {
    const out: ConfigDoc[] = [];
    for (const link of chain) {
      const doc = defaultsOf(link.decls);
      if (Object.keys(doc).length) out.push({ layer: "default", from: link.name, doc });
    }
    const file = this.filePackages();
    for (const link of chain) {
      if (file[link.name]) out.push({ layer: "file", from: link.name, doc: file[link.name] });
    }
    for (const link of chain) out.push(...(await this.stored("system", link.name, undefined)));
    if (user !== undefined) {
      for (const link of chain) out.push(...(await this.stored("user", link.name, user)));
    }
    return out;
  }

  /** The config document then the secrets document of one layer, so a secret overlays a plain value of the same key. */
  private async stored(layer: "system" | "user", name: string, user: string | undefined): Promise<ConfigDoc[]> {
    const out: ConfigDoc[] = [];
    for (const secret of [false, true]) {
      const doc = await this.read(ns(secret, user), name);
      if (doc) out.push({ layer, from: name, doc });
    }
    return out;
  }

  /** `user` undefined is the system layer. The key leaves the other document, so it lives in one place. */
  async write(user: string | undefined, name: string, key: string, value: unknown, secret: boolean): Promise<void> {
    const doc = { ...((await this.read(ns(secret, user), name)) ?? {}), [key]: value };
    await this.put(ns(secret, user), name, doc);
    const other = await this.read(ns(!secret, user), name);
    if (other && key in other) {
      const { [key]: _, ...rest } = other;
      await this.put(ns(!secret, user), name, rest);
    }
  }

  /** Removes the key from both documents; true when either held it. */
  async remove(user: string | undefined, name: string, key: string): Promise<boolean> {
    let found = false;
    for (const secret of [false, true]) {
      const doc = await this.read(ns(secret, user), name);
      if (!doc || !(key in doc)) continue;
      found = true;
      const { [key]: _, ...rest } = doc;
      await this.put(ns(secret, user), name, rest);
    }
    return found;
  }

  /** Drops one person's two documents for a package, as an uninstall does. */
  async forgetPackage(user: string, name: string): Promise<void> {
    for (const secret of [false, true]) await this.put(ns(secret, user), name, {});
  }

  /** Clears both of one person's namespaces. */
  async forgetUser(user: string): Promise<void> {
    for (const secret of [false, true]) {
      const space = ns(secret, user);
      await this.store(space).clear();
      this.cache.delete(space);
    }
  }

  /** Copies both system documents of one package name to another, as a promote does. */
  async copySystem(from: string, to: string): Promise<void> {
    for (const secret of [false, true]) {
      const doc = await this.read(ns(secret, undefined), from);
      if (doc) await this.put(ns(secret, undefined), to, doc);
    }
  }

  invalidate(): void {
    this.cache.clear();
  }

  private store(space: string): Store {
    let s = this.stores.get(space);
    if (!s) this.stores.set(space, (s = this.driver.open(space, { private: space.startsWith("secrets/") })));
    return s;
  }

  private async read(space: string, name: string): Promise<Record<string, unknown> | undefined> {
    let docs = this.cache.get(space);
    if (!docs) this.cache.set(space, (docs = new Map()));
    if (!docs.has(name)) docs.set(name, (await this.store(space).get<Record<string, unknown>>(name)) ?? null);
    const doc = docs.get(name);
    return doc ? structuredClone(doc) : undefined;
  }

  /** An empty document is deleted rather than kept, so a listing shows only packages with something set. */
  private async put(space: string, name: string, doc: Record<string, unknown>): Promise<void> {
    let docs = this.cache.get(space);
    if (!docs) this.cache.set(space, (docs = new Map()));
    if (Object.keys(doc).length) {
      await this.store(space).set(name, doc);
      docs.set(name, structuredClone(doc));
    } else {
      await this.store(space).delete(name);
      docs.set(name, null);
    }
  }
}

function ns(secret: boolean, user: string | undefined): string {
  return `${secret ? "secrets" : "config"}/${user === undefined ? "system" : `users/${user}`}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
