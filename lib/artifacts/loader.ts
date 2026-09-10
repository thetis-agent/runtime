/** Preserve source URLs and worker imports while refusing unverified TypeScript execution; ADR 0037. */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verified, limits } from './verify.mjs';
let modules = 0; let bytes = 0;
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !fileURLToPath(url).endsWith('.ts')) return nextLoad(url, context);
  if (++modules > limits.modules) throw Object.assign(new Error('The execution module pool is full.'), { code: 'budget' });
  const source = verified(fileURLToPath(url)); bytes += source.length;
  if (bytes > limits.totalBytes) throw Object.assign(new Error('The execution module graph exceeds its byte limit.'), { code: 'budget' });
  return { format: 'module', source, shortCircuit: true };
} });
