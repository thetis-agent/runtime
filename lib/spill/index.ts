/** Stream results into atomic, person-scoped artifacts with bounded previews; TE-016, ADR 0015 §10. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const defaults = { inlineBytes: 32768, resultBytes: 64 * 1024 * 1024, previewBytes: 4096 };
export class SpillSink {
  readonly #space: string;
  readonly #id: string;
  readonly #limits: typeof defaults;
  readonly #hash = createHash('sha256');
  #bytes = 0;
  #inline = Buffer.alloc(0);
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #file: FileHandle | undefined;
  #temporary: string | undefined;
  #final: string | undefined;
  #finished = false;

  constructor(space: string, id: string, limits = defaults) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new Error('Call ids must be safe artifact names.');
    this.#space = space; this.#id = id; this.#limits = limits;
  }

  async write(chunk: Uint8Array): Promise<Result<void, 'budget' | 'outside-roots' | 'io'>> {
    if (this.#finished) throw new Error('Cannot write a finished spill sink.');
    if (this.#bytes + chunk.byteLength > this.#limits.resultBytes) return failure('budget', 'The tool result exceeds its storage budget.');
    try {
      if (!this.#file && this.#bytes + chunk.byteLength > this.#limits.inlineBytes) {
        const opened = await this.#open();
        if (!opened.ok) return opened;
      }
      if (this.#file) await this.#file.writeFile(chunk);
      else this.#inline = Buffer.concat([this.#inline, chunk]);
      this.#hash.update(chunk); this.#bytes += chunk.byteLength;
      if (this.#head.length < this.#limits.previewBytes) this.#head = Buffer.concat([this.#head, chunk.subarray(0, this.#limits.previewBytes - this.#head.length)]);
      this.#tail = Buffer.concat([this.#tail, chunk.subarray(Math.max(0, chunk.byteLength - this.#limits.previewBytes))]).subarray(-this.#limits.previewBytes);
      return { ok: true, value: undefined };
    } catch { return failure('io', 'The tool result could not be written to the person’s space.'); }
  }

  async finish() {
    if (this.#finished) throw new Error('Cannot finalize a spill sink twice.');
    this.#finished = true;
    const hash = `sha256:${this.#hash.digest('hex')}`;
    try {
      if (this.#file && this.#temporary && this.#final) {
        await this.#file.sync(); await this.#file.close(); this.#file = undefined;
        await link(this.#temporary, this.#final);
        await unlink(this.#temporary); this.#temporary = undefined;
        return { ok: true, value: { text: this.#head.toString(), spilled: {
          path: this.#final, bytes: this.#bytes, hash, head: this.#head.toString(), tail: this.#tail.toString()
        } } } satisfies { ok: true; value: unknown };
      }
      return { ok: true, value: { text: this.#inline.toString(), spilled: undefined } } satisfies { ok: true; value: unknown };
    } catch { return failure('io', 'The tool result could not be finalized atomically.'); }
  }

  async abort(): Promise<Result<void, 'io'>> {
    this.#finished = true;
    try {
      await this.#file?.close(); this.#file = undefined;
      if (this.#temporary) { await unlink(this.#temporary); this.#temporary = undefined; }
      return { ok: true, value: undefined };
    } catch { return failure('io', 'The incomplete tool result could not be removed.'); }
  }

  async #open(): Promise<Result<void, 'outside-roots'>> {
    const space = await realpath(this.#space);
    const directory = join(space, 'tool-output');
    await mkdir(directory, { recursive: true });
    const canonical = await realpath(directory);
    const child = relative(space, canonical);
    if (child.startsWith('..') || child.startsWith('/')) return failure('outside-roots', 'Tool output is outside the person’s space.');
    this.#temporary = join(canonical, `.${this.#id}-${randomBytes(8).toString('hex')}.partial`);
    this.#final = join(canonical, this.#id);
    this.#file = await open(this.#temporary, 'wx', 0o600);
    await this.#file.writeFile(this.#inline); this.#inline = Buffer.alloc(0);
    return { ok: true, value: undefined };
  }
}
