/** Read runtime configuration from the inherited principal and activate only recorded packages; KS-001, KS-009. */
import type { Peer } from '../../lib/socket/index.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import { validator } from '../../lib/package-loader/index.ts';
import type { Setup } from '../../lib/package-loader/types.ts';
import type { ConnectKernel } from '../../contracts/kernel-socket/types.ts';
import type { Environment } from './environment.ts';

export async function initialize(peer: Peer, environment: Environment, schemas: Schemas, identity: ConnectKernel, token: string): Promise<Result<void>> {
  if (identity.scope !== 'person') return failure('auth', 'An environment requires a person-scoped inherited principal.');
  const supplied = await peer.call('profile.get', {}); if (!supplied.ok) return supplied;
  if (!isObject(supplied.value) || !isObject(supplied.value['runtime'])) return failure('invalid-args', 'The kernel supplied no environment runtime.');
  const setup = { ...supplied.value, runtime: { ...supplied.value['runtime'], person: identity.person, token } };
  const check = await validator<Setup>(schemas, 'setup');
  if (!check(setup)) return failure('invalid-args', 'The kernel supplied an invalid environment profile.');
  const loaded = await environment.start(setup); if (!loaded.ok) return loaded;
  for (const [source, registration] of loaded.value.registrations) {
    const entry = setup.entries.find(entry => `${entry.manifest.name}@${entry.manifest.version}` === source);
    if (!entry) return failure('envelope', 'The worker registered an unrecorded package.');
    const registered = await peer.call('package.register', { ...registration, package: entry.manifest.name }); if (!registered.ok) return registered;
  }
  for (const message of loaded.value.gaps) {
    const sent = await peer.notify({ note: 'notice', params: { message } }); if (!sent.ok) return sent;
  }
  return { ok: true, value: undefined };
}
