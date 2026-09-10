/** Retire only unpinned never-default versions while preserving immutability; proposal §13.14. */
import { git, reference } from './git.ts';
import { failure } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import type { Registry, Pin } from './index.ts';
export const retentionMs = 30 * 86400000;

export async function retain(registry: Registry, livePins: readonly Pin[], defaults: readonly Pin[], now: number): Promise<Result<string[]>> {
  if (!Number.isSafeInteger(now) || now < 0 || livePins.length + defaults.length > 10000) return failure('invalid-args', 'The registry retention inputs exceed their bounds.');
  const releases = await registry.versions(); if (!releases.ok) return releases;
  const live = new Set(livePins.map(pin => pin.commit)); const kept = new Set(defaults.map(pin => pin.commit));
  const removed: string[] = [];
  for (const release of releases.value) {
    if (now - release.at < retentionMs || kept.has(release.pin.commit)) continue;
    const tag = reference(release.pin.name, release.pin.version);
    const hidden = `refs/thetis/hidden/${release.pin.name}@${release.pin.version}`;
    const marker = await git(registry.path, ['hash-object', '-w', '--stdin'], Buffer.from(JSON.stringify(release.pin))); if (!marker.ok) return marker;
    const tombstone = `refs/thetis/retired/${release.pin.name}@${release.pin.version}`;
    const commands = [`start`, `create ${tombstone} ${marker.value.toString('utf8').trim()}`, `delete ${tag} ${release.pin.commit}`];
    if (live.has(release.pin.commit)) commands.push(`create ${hidden} ${release.pin.commit}`);
    commands.push('prepare', 'commit', '');
    const result = await git(registry.path, ['update-ref', '--stdin'], Buffer.from(commands.join('\n'))); if (!result.ok) return failure('conflict', 'The registry changed during retention.');
    removed.push(`${release.pin.name}@${release.pin.version}`);
  }
  const hidden = await git(registry.path, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/thetis/hidden/']); if (!hidden.ok) return hidden;
  for (const row of hidden.value.toString('utf8').trim().split('\n').filter(Boolean)) {
    const [ref, commit] = row.split(' '); if (!ref || !commit) return failure('io', 'The registry retention reference is invalid.');
    if (!live.has(commit) && !kept.has(commit)) { const deleted = await git(registry.path, ['update-ref', '-d', ref, commit]); if (!deleted.ok) return deleted; }
  }
  const collected = await git(registry.path, ['-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--prune=now']);
  return collected.ok ? { ok: true, value: removed } : collected;
}
