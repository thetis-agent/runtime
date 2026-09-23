// A minimal inversion-of-control container: typed tokens, lazy singleton factories,
// and overridable bindings so tests and packages can swap implementations.

export interface Token<T> {
  readonly key: symbol;
  readonly __type?: T;
}

export function token<T>(name: string): Token<T> {
  return { key: Symbol(name) };
}

export type Factory<T> = (c: Container) => T;

export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();

  bind<T>(tok: Token<T>, factory: Factory<T>): this {
    this.factories.set(tok.key, factory);
    this.instances.delete(tok.key);
    return this;
  }

  has<T>(tok: Token<T>): boolean {
    return this.factories.has(tok.key);
  }

  get<T>(tok: Token<T>): T {
    if (this.instances.has(tok.key)) return this.instances.get(tok.key) as T;
    const factory = this.factories.get(tok.key);
    if (!factory) throw new Error(`No binding for ${tok.key.description ?? "token"}`);
    const instance = factory(this) as T;
    this.instances.set(tok.key, instance);
    return instance;
  }
}
