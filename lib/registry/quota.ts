/** Enforce the publication ceiling atomically across concurrent publishers; ADR 0004 §10. */
import { git } from './git.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
export async function quota(repository: string, name: string, at: number): Promise<Result<string>> {
  const ref = `refs/thetis/publications/${String(Math.floor(at / 86400000))}/${name}`;
  const current = await git(repository, ['rev-parse', '--verify', ref]); let count = 0;
  if (current.ok) {
    const content = await git(repository, ['cat-file', 'blob', current.value.toString('utf8').trim()]); if (!content.ok) return content;
    count = Number(content.value.toString('utf8'));
    if (!Number.isSafeInteger(count) || count < 0 || count > 3) return failure('io', 'The registry publication counter is invalid.');
  }
  if (count >= 3) return failure('budget', 'This package has already been published three times today.');
  const next = await git(repository, ['hash-object', '-w', '--stdin'], Buffer.from(String(count + 1))); if (!next.ok) return next;
  return { ok: true, value: `update ${ref} ${next.value.toString('utf8').trim()} ${current.ok ? current.value.toString('utf8').trim() : '0'.repeat(40)}` };
}
