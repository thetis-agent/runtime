/** Recapture changed dynamic providers before full matching, then require the real probe; ADR 0045. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watchWork } from '../lib/deployment/work.ts';
import type { Result } from '../lib/schema/index.ts';
import { workRegistrationFixture, producerCode } from './work-registration-fixture.ts';

await test('GN-001 comment-only work edits recapture dynamic provisions through the actual watcher', async () => {
  const fixture = await workRegistrationFixture(); let launches = 0;
  try {
    for (const name of ['consumer', 'producer']) {
      const notified = Promise.withResolvers<Result<void>>();
      const current = await fixture.current();
      const opened = await watchWork(fixture.setting, current, fixture.config, fixture.runtime,
        path => { launches++; return fixture.launch(path); }, fixture.schemas, (_target, result) => { notified.resolve(result); });
      assert.ok(opened.ok, JSON.stringify(opened));
      try {
        await writeFile(join(fixture.work, name, 'index.ts'), '// comment-only edit\n', { flag: 'a' });
        const result = await notified.promise; assert.ok(result.ok, JSON.stringify(result));
        const status = fixture.runtime.status(fixture.person, 'alice'); assert.ok(status.ok); assert.equal(status.value['ready'], true);
        assert.equal(status.value['generation'], name === 'consumer' ? 2 : 3); assert.equal(launches, name === 'consumer' ? 0 : 1);
      } finally { const closed = await opened.value.close(); assert.ok(closed.ok, JSON.stringify(closed)); }
    }
  } finally { await fixture.close(); }
});

await test('GN-001 missing, outside-envelope and probe-divergent work provisions preserve the serving generation', async () => {
  const fixture = await workRegistrationFixture();
  try {
    for (const code of [producerCode.replace('"service/dynamic":"1.0.0"', ''), producerCode.replace('service/dynamic', 'service/outside'),
      `export const stages = {}; export function init(_profile, context) { context.register({requires:{}, provides:context.state.includes('/discovery-') ? {'service/dynamic':'1.0.0'} : {}}); }`]) {
      const notified = Promise.withResolvers<Result<void>>();
      const current = await fixture.current();
      const opened = await watchWork(fixture.setting, current, fixture.config, fixture.runtime, path => fixture.launch(path), fixture.schemas,
        (_target, result) => { notified.resolve(result); }); assert.ok(opened.ok, JSON.stringify(opened));
      try {
        await writeFile(join(fixture.work, 'producer/index.ts'), code);
        const result = await notified.promise; assert.equal(result.ok, false, JSON.stringify(result));
        const status = fixture.runtime.status(fixture.person, 'alice'); assert.ok(status.ok); assert.equal(status.value['ready'], true); assert.equal(status.value['generation'], 1);
        const sessions = await fixture.runtime.session(fixture.person, 'session.list', {}); assert.ok(sessions.ok, JSON.stringify(sessions));
      } finally { await opened.value.close(); }
    }
  } finally { await fixture.close(); }
});
