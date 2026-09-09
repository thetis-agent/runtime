/** Deliver spawn secrets before package evaluation without exposing them in argv or mounts; PR-013. */
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';

const maximum = 65536;
type Delivery = { ok: true; value: Record<string, string> } | { ok: false; error: { code: 'auth'; message: string } };
const refusal = (): Delivery => ({ ok: false, error: { code: 'auth', message: 'The inherited secret delivery is invalid.' } });

async function delivery(): Promise<Delivery> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    const stream: AsyncIterable<unknown> = createReadStream('', { fd: 6, autoClose: true });
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array) || (bytes += chunk.length) > maximum) return refusal();
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return refusal();
    const entries: [string, unknown][] = Object.entries(value);
    if (entries.length > 32) return refusal();
    const result: Record<string, string> = {};
    for (const [name, secret] of entries) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || /^(PATH|HOME|ENV|BASH_ENV|SHELLOPTS|LD_.*|NODE_.*)$/u.test(name) || typeof secret !== 'string' || secret.includes('\0') || Buffer.byteLength(secret) > 16384) return refusal();
      result[name] = secret;
    }
    return { ok: true, value: result };
  } catch { return refusal(); }
}

const received = await delivery(); const entry = process.argv[2];
if (!received.ok || !entry || !isAbsolute(entry)) {
  process.stderr.write(`${JSON.stringify(received.ok ? refusal() : received)}\n`); process.exitCode = 1;
} else {
  for (const [name, value] of Object.entries(received.value)) process.env[name] = value;
  process.argv.splice(1, 1);
  try { await import(pathToFileURL(entry).href); }
  catch { process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'io', message: 'The sandbox entry could not start.' } })}\n`); process.exitCode = 1; }
}
