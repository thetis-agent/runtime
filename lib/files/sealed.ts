/** Authenticate bounded bytes without retaining keys or acquiring scope authority; implementation note 0034. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
export const sealedLimits = { plaintextBytes: 16384, envelopeBytes: 32768, aadBytes: 1024 };
export function seal(key: Uint8Array, aad: string, plaintext: string): Result<Buffer, 'invalid-args' | 'io'> {
  if (key.byteLength !== 32 || Buffer.byteLength(aad) > sealedLimits.aadBytes || Buffer.byteLength(plaintext) > sealedLimits.plaintextBytes) return failure('invalid-args', 'The sealed input exceeds its key or byte limit.');
  try {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ok: true, value: Buffer.from(JSON.stringify({ nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })) };
  } catch { return failure('io', 'The authenticated envelope could not be encoded.'); }
}
export function unseal(key: Uint8Array, aad: string, bytes: Uint8Array): Result<Buffer, 'invalid-args' | 'io'> {
  if (key.byteLength !== 32 || Buffer.byteLength(aad) > sealedLimits.aadBytes || bytes.byteLength > sealedLimits.envelopeBytes) return failure('invalid-args', 'The sealed input exceeds its key or byte limit.');
  let partial: Buffer | undefined;
  try {
    const envelope: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isObject(envelope) || typeof envelope['nonce'] !== 'string' || typeof envelope['tag'] !== 'string' || typeof envelope['ciphertext'] !== 'string') return failure('invalid-args', 'The authenticated envelope is invalid.');
    const nonce = Buffer.from(envelope['nonce'], 'base64'); const tag = Buffer.from(envelope['tag'], 'base64');
    if (nonce.length !== 12 || tag.length !== 16) return failure('io', 'The authenticated envelope could not be decoded.');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
    const ciphertext = Buffer.from(envelope['ciphertext'], 'base64');
    if (ciphertext.length > sealedLimits.plaintextBytes) return failure('invalid-args', 'The authenticated envelope is invalid.');
    partial = decipher.update(ciphertext);
    return { ok: true, value: Buffer.concat([partial, decipher.final()]) };
  } catch { return failure('io', 'The authenticated envelope could not be decoded.'); }
  finally { partial?.fill(0); }
}
