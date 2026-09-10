/** Consume one bounded compilation request without inheriting run authority; ADR 0037, KS-001. */
import validate from './job.mjs';
import { buildTree } from './build.ts';
const limits = { requestBytes: 16384 };
async function main(): Promise<void> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const value of process.stdin) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > limits.requestBytes) throw new Error('The compilation request exceeds its byte budget.');
    chunks.push(chunk);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!validate(request)) throw new Error('The compilation request violates its schema.');
  if (request.source === request.destination) throw new Error('The compilation destination must be separate from its source.');
  await buildTree(request.source, request.destination, false, request.previous);
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}
try { await main(); } catch { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'invalid-args', message: 'The package could not produce bounded execution artifacts.' } })}\n`); process.exitCode = 1; }
