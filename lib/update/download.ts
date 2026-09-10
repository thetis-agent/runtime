/** Stream bounded HTTPS assets and refuse transport downgrades before consuming bytes; ADR 0048, GN-002. */
import { open } from 'node:fs/promises';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const downloadLimits = { redirects: 5, deadlineMs: 300000 };
async function response(source: string, signal: AbortSignal): Promise<Result<Response>> {
  let url = new URL(source);
  for (let redirect = 0; redirect <= downloadLimits.redirects; redirect++) {
    if (url.protocol !== 'https:' || url.username || url.password) return failure('invalid-args', 'Release downloads require HTTPS without URL credentials.');
    const result = await fetch(url, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(result.status)) return result.ok && result.body ? { ok: true, value: result } : failure('io', 'The release remote refused the download.');
    await result.body?.cancel();
    const location = result.headers.get('location'); if (!location) return failure('io', 'The release redirect has no destination.');
    url = new URL(location, url);
  }
  return failure('budget', 'The release download exceeds its redirect budget.');
}

async function consume(url: string, maximum: number, write: (chunk: Uint8Array) => Promise<void>): Promise<Result<number>> {
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, downloadLimits.deadlineMs);
  try {
    const opened = await response(url, controller.signal); if (!opened.ok) return opened;
    let bytes = 0;
    if (!opened.value.body) return failure('io', 'The release remote answered without bytes.');
    for await (const chunk of opened.value.body) {
      bytes += chunk.length; if (bytes > maximum) return failure('budget', 'A release asset exceeds its byte budget.');
      await write(chunk);
    }
    return { ok: true, value: bytes };
  } catch { return failure('io', 'The release asset could not be downloaded.'); }
  finally { clearTimeout(timer); }
}

export async function download(url: string, destination: string, maximum: number): Promise<Result<number>> {
  const file = await open(destination, 'wx', 0o600);
  try { return await consume(url, maximum, chunk => file.writeFile(chunk)); } finally { await file.close(); }
}

export async function fetched(url: string, maximum: number): Promise<Result<Buffer>> {
  const chunks: Uint8Array[] = [];
  const read = await consume(url, maximum, chunk => { chunks.push(chunk); return Promise.resolve(); });
  return read.ok ? { ok: true, value: Buffer.concat(chunks, read.value) } : read;
}
