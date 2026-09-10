/** Export bounded coverage through a pipe without granting tests a writable host report mount; ADR 0012, ADR 0035. */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

export const coverageLimits = { rawBytes: 536870912, reportBytes: 67108864, lineBytes: 65536, files: 10000 };
export const coverageFiles = ['lcov.info', 'summary.json', 'summary.md'];
export function coverageFlags(): string[] {
  return ['--import', '/workspace/scripts/coverage-context.mjs', '--experimental-test-coverage', '--test-reporter=spec', '--test-reporter-destination=stderr',
    '--test-reporter=/workspace/scripts/coverage-reporter.mjs', '--test-reporter-destination=stdout',
    ...['kernel', 'lib', 'contracts', 'packages'].map(directory => `--test-coverage-include=/workspace/${directory}/**/*.ts`),
    '--test-coverage-exclude=**/*.test.ts', '--test-coverage-exclude=**/node_modules/**'];
}

interface Count { found: number; hit: number }
interface Totals { files: number; lines: Count; branches: Count; functions: Count }
export interface Summary { runtime: Totals; packages: Totals; combined: Totals }
const empty = (): Totals => ({ files: 0, lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } });
const fields = { LF: ['lines', 'found'], LH: ['lines', 'hit'], BRF: ['branches', 'found'], BRH: ['branches', 'hit'], FNF: ['functions', 'found'], FNH: ['functions', 'hit'] } as const;
const metric = (value: string): value is keyof typeof fields => Object.hasOwn(fields, value);

/** Reject malformed or incomplete records rather than publish misleading zero coverage. */
export class Coverage {
  readonly summary: Summary = { runtime: empty(), packages: empty(), combined: empty() };
  readonly #seen = new Set<string>();
  #current: { repository: 'runtime' | 'packages'; totals: Totals; fields: Set<string> } | undefined;
  line(line: string): string {
    if (Buffer.byteLength(line) > coverageLimits.lineBytes) throw new Error('A coverage line exceeds its byte limit.');
    if (line.startsWith('SF:')) return this.#source(line.slice(3));
    if (line === 'end_of_record') { this.#finish(); return line; }
    const at = line.indexOf(':'); const name = line.slice(0, at);
    if (metric(name)) {
      if (!this.#current || this.#current.fields.has(name)) throw new Error('Coverage has a misplaced or repeated counter.');
      const text = line.slice(at + 1); const value = Number(text);
      if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value)) throw new Error('Coverage has an invalid counter.');
      const [kind, count] = fields[name]; this.#current.totals[kind][count] = value; this.#current.fields.add(name);
    }
    return line;
  }
  #source(source: string): string {
    if (this.#current) throw new Error('Coverage has an unterminated source record.');
    const relative = source.replace(/^\/workspace\//u, '').replace(/^runtime\/(?=(?:kernel|lib|contracts)\/)/u, '');
    if (!/^(?:kernel|lib|contracts|packages)\//u.test(relative) || relative.split('/').some(part => part === '..' || part === '.' || part === '') || !relative.endsWith('.ts') || relative.endsWith('.test.ts')) {
      throw new Error('Coverage names a source outside the runtime/packages trees.');
    }
    const repository = relative.startsWith('packages/') ? 'packages' : 'runtime';
    const path = repository === 'packages' ? relative : `runtime/${relative}`;
    if (this.#seen.has(path) || this.#seen.size >= coverageLimits.files) throw new Error('Coverage has duplicate files or exceeds its file limit.');
    this.#seen.add(path); this.#current = { repository, totals: empty(), fields: new Set() };
    return `SF:${path}`;
  }
  #finish(): void {
    const current = this.#current;
    if (!current || current.fields.size !== Object.keys(fields).length) throw new Error('Coverage has an incomplete source record.');
    for (const kind of ['lines', 'branches', 'functions'] as const) {
      const value = current.totals[kind]; if (value.hit > value.found) throw new Error('Coverage hits exceed its declared total.');
      for (const destination of [this.summary[current.repository], this.summary.combined]) {
        for (const key of ['found', 'hit'] as const) {
          destination[kind][key] += value[key];
          if (!Number.isSafeInteger(destination[kind][key])) throw new Error('Coverage totals exceed safe integer precision.');
        }
      }
    }
    this.summary[current.repository].files++; this.summary.combined.files++; this.#current = undefined;
  }
  finish(): Summary {
    if (this.#current || this.summary.combined.files === 0) throw new Error('Coverage is empty or its last record is incomplete.');
    return this.summary;
  }
}

const percentage = (count: Count): string => count.found === 0 ? 'n/a' : `${(count.hit / count.found * 100).toFixed(2)}% (${String(count.hit)}/${String(count.found)})`;
export function markdown(summary: Summary): string {
  return ['## Test coverage', '', '| Repository | Files | Lines | Branches | Functions |', '| --- | ---: | ---: | ---: | ---: |',
    ...(['runtime', 'packages', 'combined'] as const).map(name => {
      const total = summary[name]; return `| ${name} | ${String(total.files)} | ${percentage(total.lines)} | ${percentage(total.branches)} | ${percentage(total.functions)} |`;
    }), '', 'Coverage covers source modules loaded by the Node test processes. Separately spawned payload processes and unloaded files are outside this report; conformance and performance checks remain required.',
    'Download the coverage artifact for LCOV details. No percentage threshold is imposed.', ''].join('\n');
}

export async function prepareCoverage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const name of coverageFiles) await rm(join(directory, name), { force: true });
}

export async function writeCoverage(source: Readable, directory: string, sourceRoot?: string): Promise<Summary> {
  const coverage = new Coverage(); const decoder = new StringDecoder('utf8'); let pending = ''; let bytes = 0;
  const line = (value: string): string => coverage.line(sourceRoot && value.startsWith(`SF:${sourceRoot}/`) ? `SF:${value.slice(sourceRoot.length + 4)}` : value);
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        bytes += chunk.length; if (bytes > coverageLimits.reportBytes) throw new Error('Coverage exceeds its report byte limit.');
        const lines = `${pending}${decoder.write(chunk)}`.split('\n'); pending = lines.pop() ?? '';
        if (Buffer.byteLength(pending) > coverageLimits.lineBytes) throw new Error('A coverage line exceeds its byte limit.');
        callback(null, lines.length ? `${lines.map(line).join('\n')}\n` : '');
      } catch (error) { callback(error instanceof Error ? error : new Error('Coverage could not be decoded.')); }
    },
    flush(callback) {
      try {
        pending += decoder.end();
        if (pending) this.push(`${line(pending)}\n`);
        coverage.finish(); callback();
      } catch (error) { callback(error instanceof Error ? error : new Error('Coverage could not be completed.')); }
    },
  });
  await pipeline(source, transform, createWriteStream(join(directory, 'lcov.info'), { flags: 'wx', mode: 0o600 }));
  const summary = coverage.finish();
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(directory, 'summary.md'), markdown(summary));
  return summary;
}
