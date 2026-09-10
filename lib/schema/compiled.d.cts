/** Generated validator types; ADR 0006, ADR 0037. Do not edit. */
declare function lookup(key: string, known?: ReadonlyMap<string, { root: string }>): ((value: unknown) => boolean) | undefined;
export = lookup;
