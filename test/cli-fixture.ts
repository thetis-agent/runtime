/** Exercise CLI commands through real fenced RPC and real sessions; KS-004–005. */
import assert from 'node:assert/strict';
import { sessionFixture } from '@/test/session-fixture.ts';
import { socketPair } from '@/lib/socket/pair.ts';
import { Peer } from '@/lib/socket/index.ts';
import { accept } from '@/kernel/socket/index.ts';
import type { Operation, Operations } from '@/kernel/socket/index.ts';
import type { Method } from '@/contracts/kernel-socket/types.ts';
import type { Input } from '@/contracts/turn-events/types.ts';
import { capabilities } from '@/packages/cli/index.ts';
import { failure } from '@/lib/schema/index.ts';

export function cliOperations(f: Awaited<ReturnType<typeof sessionFixture>>): Operations {
  const check = f.runtime.schemas.validator<Input>('turn-events', 'input');
  const methods = new Map<Method, Operation>([
    ['health.probe', () => Promise.resolve({ ok: true, value: { ready: true } })],
    ['profile.get', () => Promise.resolve({ ok: true, value: {} })],
    ['env.status', run => Promise.resolve({ ok: true, value: { person: run.person, state: 'LIVE' } })],
    ['session.list', () => f.sessions.list()],
    ['session.create', (_run, params) => {
      const surface = params['surface']; const project = params['project']; assert.ok(typeof surface === 'string' && (project === undefined || typeof project === 'string'));
      return f.sessions.create({ surface, ...(project === undefined ? {} : { project }) });
    }],
    ['session.submit', (_run, params) => {
      const { conversation, input } = params;
      return typeof conversation === 'string' && check(input) ? f.sessions.submit(conversation, input) : Promise.resolve(failure('invalid-args', 'The session input is invalid.'));
    }],
    ['session.cancel', (_run, params) => typeof params['conversation'] === 'string' ? Promise.resolve(f.sessions.cancel(params['conversation'])) : Promise.resolve(failure('invalid-args', 'The conversation is invalid.'))]
  ]);
  return { methods, notes: ['run.stop', 'env.updated'], note: () => Promise.resolve({ ok: true, value: undefined }) };
}

export async function cliFixture() {
  const f = await sessionFixture(); const pair = await socketPair(); assert.ok(pair.ok);
  const accepting = accept(pair.value.peer, f.provider.token, f.provider.identity, f.runtime.schemas, f.runtime.clock, cliOperations(f));
  const peer = new Peer(pair.value.client, f.runtime.schemas, f.runtime.clock, capabilities, { handlers: new Map(), note: () => Promise.resolve({ ok: true, value: undefined }) });
  assert.ok((await peer.connect()).ok); const accepted = await accepting; assert.ok(accepted.ok);
  return { ...f, peer, async close() {
    peer.close(); accepted.value.close(); await peer.finished(); await accepted.value.finished(); assert.ok((await pair.value.close()).ok); await f.close();
  } };
}
