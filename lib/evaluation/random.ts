/** Keep paired mutation and resampling deterministic without exposing the seed secret; ADR 0004 §2. */
import { createHmac, createHash } from 'node:crypto';

export function seed(secret: string, task: string, run: number): string {
  return createHmac('sha256', secret).update(JSON.stringify([task, run])).digest('hex');
}

export function seedIdentity(secret: string): string {
  return `sha256:${createHmac('sha256', secret).update('thetis/evaluator/seeds/v1').digest('hex')}`;
}

export function random(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
