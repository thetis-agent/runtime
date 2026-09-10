/** Read only the installer's recorded choices, and refuse an update policy no record has accepted; ADR 0048, ADR 0049. */
import { join } from 'node:path';
import { readBounded } from '@/lib/files/read-bounded.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Result, Schemas } from '@/lib/schema/index.ts';
import type { Policy } from './policy.ts';

export const installLimits = { fileBytes: 65536 };
export interface Install {
  version: 1; prefix: string; state: string; release: string; remote: string; releaseUrl: string;
  allowedSigners: string; signer: string; policy: Policy; origin: string; operator: string; login: string; service: 'system' | 'user' | 'none';
}

const path = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const installSchema = {
  type: 'object', required: ['version', 'prefix', 'state', 'release', 'remote', 'releaseUrl', 'allowedSigners', 'signer', 'policy', 'origin', 'operator', 'login', 'service'],
  properties: {
    version: { const: 1 }, prefix: path, state: path, release: { type: 'string', pattern: '^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$' },
    remote: path, releaseUrl: path, allowedSigners: path, signer: { type: 'string', minLength: 1, maxLength: 256 },
    policy: { enum: ['none', 'fixes', 'improvements'] }, origin: path, operator: { type: 'string', minLength: 1, maxLength: 128 },
    login: { type: 'string', minLength: 1, maxLength: 128 }, service: { enum: ['system', 'user', 'none'] },
  },
} as const;

export async function readInstall(prefix: string, schemas: Schemas): Promise<Result<Install>> {
  const bytes = await readBounded(join(prefix, 'etc/install.json'), installLimits.fileBytes); if (!bytes.ok) return bytes;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.value.toString('utf8')); } catch { return failure('invalid-args', 'The recorded installation choices are not valid JSON.'); }
  return schemas.compile<Install>({ ...installSchema })(parsed) ? { ok: true, value: parsed } : failure('invalid-args', 'The recorded installation choices do not match their published shape.');
}

/** ADR 0049 is Proposed, so the policy's code path is built and tested while only `none` is honoured. */
export function honoured(policy: Policy): Result<'none'> {
  return policy === 'none' ? { ok: true, value: 'none' }
    : failure('forbidden', `An update policy of ${policy} pre-authorises the kernel maintenance command and stays refused until the operator accepts ADR 0049.`);
}

export const releases = (install: Install): string => join(install.prefix, 'releases');
export const statusPath = (install: Install): string => join(install.state, 'updates/status.json');
export const controlPath = (install: Install): string => join(install.state, 'supervisor.sock');
