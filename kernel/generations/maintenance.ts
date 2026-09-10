/** Resolve maintenance authority from a kernel-issued session before changing trusted code pins; GN-007, KS-015. */
import type { Identity } from '../identity/index.ts';
import type { Maintenance, Revision } from '../../lib/maintenance/index.ts';
import { failure } from '../../lib/schema/index.ts';
import type { Result } from '../../lib/schema/index.ts';
export function maintenance(identity: Identity, controller: Maintenance) {
  return (session: string, revision: Revision, baseline: number): Promise<Result<void>> => {
    const person = identity.resolveSession(session);
    if (!person.ok) return Promise.resolve(person);
    return person.value.role === 'admin' ? controller.upgrade(revision, baseline, true) : Promise.resolve(failure('forbidden', 'Kernel maintenance requires an administrator.'));
  };
}
