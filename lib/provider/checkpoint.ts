/** Persist reservations before vendor access so restart cannot reset spend; ADR 0020, PR-010. */
import { readFile, lstat } from 'node:fs/promises';
import type { Schemas, Result, Validator } from '../schema/index.ts';
import { failure, isObject } from '../schema/index.ts';
import { atomicWrite } from '../files/atomic.ts';
import { readBounded } from '../files/read-bounded.ts';
import type { Checkpoint, Ledger } from './types.ts';
import { migrate } from './migrate.ts';

export const limits = { bytes: 4 * 1024 * 1024, queued: 64, accounts: 4096 };
export class BudgetCheckpoint {
  readonly initial: Ledger;
  readonly #path: string;
  readonly #validate: Validator<Ledger>;
  #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #failed = false;
  private constructor(path: string, ledger: Ledger, validate: Validator<Ledger>) { this.#path = path; this.initial = structuredClone(ledger); this.#validate = validate; }

  static async open(path: string, schemas: Schemas): Promise<Result<BudgetCheckpoint>> {
    const schema: unknown = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
    if (!isObject(schema)) throw new Error('The committed budget schema is invalid.');
    const check = schemas.compile<Checkpoint>(schema);
    const validate = schemas.definition<Ledger>(schema, 'ledger');
    const present = await exists(path); if (!present.ok) return present;
    if (!present.value) {
      const empty: Ledger = { version: 2, people: [], runs: [] };
      const saved = await atomicWrite(path, Buffer.from(JSON.stringify(empty)));
      return saved.ok ? { ok: true, value: new BudgetCheckpoint(path, empty, validate) } : saved;
    }
    const bytes = await readBounded(path, limits.bytes); if (!bytes.ok) return bytes;
    try {
      const value: unknown = JSON.parse(bytes.value.toString('utf8'));
      if (!check(value)) return failure('invalid-args', 'The persisted budget checkpoint is invalid.');
      const ledger = migrate(value);
      if (!validate(ledger) || !inventory(ledger)) return failure('invalid-args', 'The persisted budget checkpoint is invalid.');
      return { ok: true, value: new BudgetCheckpoint(path, ledger, validate) };
    } catch { return failure('invalid-args', 'The persisted budget checkpoint is invalid.'); }
  }

  save(ledger: Ledger): Promise<Result<void>> {
    if (this.#failed) return Promise.resolve(failure('io', 'The budget checkpoint writer has failed.'));
    if (!this.#validate(ledger) || !inventory(ledger)) return Promise.resolve(failure('invalid-args', 'The budget checkpoint violates its schema or account limit.'));
    const bytes = Buffer.from(JSON.stringify(ledger));
    if (bytes.length > limits.bytes || this.#queued >= limits.queued) return Promise.resolve(failure('budget', 'The budget checkpoint exceeds its storage or queue limit.'));
    this.#queued++;
    const written = this.#tail.then(async () => {
      if (this.#failed) return failure('io', 'The budget checkpoint writer has failed.');
      const result = await atomicWrite(this.#path, bytes); if (!result.ok) this.#failed = true; return result;
    });
    this.#tail = written;
    return written.finally(() => { this.#queued--; });
  }
}

function inventory(ledger: Ledger): boolean {
  return ledger.people.length + ledger.runs.length <= limits.accounts
    && new Set(ledger.people.map(person => person.person)).size === ledger.people.length
    && new Set(ledger.runs.map(run => run.digest)).size === ledger.runs.length;
}

async function exists(path: string): Promise<Result<boolean>> {
  try { const entry = await lstat(path); return entry.isFile() ? { ok: true, value: true } : failure('io', 'The budget checkpoint is not a regular file.'); }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { ok: true, value: false } : failure('io', 'The budget checkpoint could not be inspected.'); }
}
