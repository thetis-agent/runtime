/** Delete only an exact lease-cleared release while retaining its immutable tombstone; KS-011. */
import { git, reference } from './git.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Registry, Pin } from './index.ts';

export async function prune(registry: Registry, pin: Pin): Promise<Result<{ pruned: string }>> {
  const release = await registry.inspect(pin.name, pin.version); if (!release.ok) return release;
  if (release.value.pin.commit !== pin.commit || release.value.pin.hash !== pin.hash) return failure('hash-mismatch', 'The pruned release does not match its immutable pin.');
  const tombstone = `refs/thetis/retired/${pin.name}@${pin.version}`;
  const marker = await git(registry.path, ['rev-parse', '--verify', tombstone]);
  const commands = ['start'];
  if (!marker.ok) {
    const object = await git(registry.path, ['hash-object', '-w', '--stdin'], Buffer.from(JSON.stringify(pin))); if (!object.ok) return object;
    commands.push(`create ${tombstone} ${object.value.toString('utf8').trim()}`);
  } else commands.push(`verify ${tombstone} ${marker.value.toString('utf8').trim()}`);
  for (const ref of [reference(pin.name, pin.version), `refs/thetis/hidden/${pin.name}@${pin.version}`]) {
    const present = await git(registry.path, ['rev-parse', '--verify', ref]);
    if (present.ok) {
      if (present.value.toString('utf8').trim() !== pin.commit) return failure('conflict', 'The registry release changed before pruning.');
      commands.push(`delete ${ref} ${pin.commit}`);
    } else commands.push(`verify ${ref} ${'0'.repeat(40)}`);
  }
  commands.push('prepare', 'commit', '');
  const deleted = await git(registry.path, ['update-ref', '--stdin'], Buffer.from(commands.join('\n'))); if (!deleted.ok) return failure('conflict', 'The registry release changed during pruning.');
  const collected = await git(registry.path, ['-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--prune=now']);
  return collected.ok ? { ok: true, value: { pruned: pin.hash } } : collected;
}
