/** Translate an already authorized isolated plan into neutral generation data; EV-006, GN-002. */
import { snapshot } from '../snapshots/index.ts';
import { failure } from '../schema/index.ts';
import type { Result } from '../schema/index.ts';
import type { Plan } from '../sandbox-runner/index.ts';
import type { Setup } from '../package-loader/types.ts';
import type { Revision } from './types.ts';
export async function executionPlan(plan: Omit<Plan, 'socket' | 'token'>, setup: Setup): Promise<Result<{ revision: Revision; state: string; setup: Setup }>> {
  const state = plan.mounts.find(mount => mount.path === '/state'); if (!state) return failure('invalid-args', 'The isolated execution state mount is absent.');
  if (!setup.runtime) return failure('invalid-args', 'The isolated execution runtime is absent.');
  const configured = { ...setup, runtime: { ...setup.runtime, endpoint: '/endpoint/service.sock' } };
  const pins: Revision['pins'] = {}; const mounts: Revision['mounts'] = [];
  for (const [index, mount] of plan.mounts.entries()) {
    if (mount.path === '/state' || mount.path === '/endpoint') continue;
    if (mount.mode === 'ro' && [plan.entry, ...setup.entries.map(entry => entry.path)].some(entry => entry === mount.path || entry.startsWith(`${mount.path}/`))) {
      const hash = await snapshot(mount.source); if (!hash.ok) return hash;
      pins[String(index)] = { source: mount.source, hash: hash.value, mount: mount.path };
    } else mounts.push({ ...mount });
  }
  return { ok: true, value: { state: state.source, setup: configured, revision: { plan: { name: plan.name, version: plan.version, entry: plan.entry, args: [...plan.args], cwd: plan.cwd, ...(plan.network ? { network: plan.network } : {}), ...(plan.execution ? { execution: plan.execution } : {}) }, pins, mounts,
    stateMount: '/state', endpointMount: '/endpoint', socketName: 'service.sock', quotaBytes: state.maximumBytes ?? 67108864, migrations: [], formats: [], migrate: 'stop' } } };
}
