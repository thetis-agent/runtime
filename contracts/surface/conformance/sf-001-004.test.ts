/** Exercise the contributed surface block against its schema; SF-001–004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schemas } from '@/lib/schema/index.ts';
import type { Surface } from '../types.ts';

const schemas = new Schemas(); await schemas.load();
const valid = schemas.validator<Surface>('surface', 'surface');

const panel = { id: 'skills', label: 'Skills', entry: '/surface/retriever-local/panel.js' };
const renderer = { kind: 'retrieve', entry: '/surface/retriever-local/rows.js' };

await test('SF-001 a block may contribute panels, renderers, or neither', () => {
  assert.ok(valid({ v: '1', panels: [panel], renderers: [renderer] }));
  assert.ok(valid({ v: '1', panels: [panel] }));
  assert.ok(valid({ v: '1', renderers: [renderer] }));
  assert.ok(valid({ v: '1' }));
  assert.ok(!valid({ panels: [panel] }), 'the contract major is required');
});

await test('SF-002 an entry outside its own served segment is refused', () => {
  for (const entry of ['/app.js', '/surface/panel.js', '/surface//panel.js', 'surface/x/panel.js',
    '/surface/x/../../app.js', '/surface/x/', '/surface/Retriever/panel.js']) {
    assert.ok(!valid({ v: '1', panels: [{ ...panel, entry }] }), `${entry} is not a servable surface asset`);
  }
  assert.ok(valid({ v: '1', panels: [{ ...panel, entry: '/surface/x/views/panel.js' }] }));
});

await test('SF-003 a panel names itself, or is refused', () => {
  assert.ok(!valid({ v: '1', panels: [{ ...panel, id: 'Skills' }] }));
  assert.ok(!valid({ v: '1', panels: [{ ...panel, id: '1skills' }] }));
  assert.ok(!valid({ v: '1', panels: [{ ...panel, label: '' }] }));
  assert.ok(!valid({ v: '1', panels: [{ ...panel, label: 'x'.repeat(33) }] }));
  assert.ok(!valid({ v: '1', panels: [{ id: 'skills', label: 'Skills' }] }));
  assert.ok(!valid({ v: '1', renderers: [{ kind: 'Retrieve', entry: renderer.entry }] }));
});

await test('SF-004 a contribution is bounded where it is declared', () => {
  const panels = Array.from({ length: 9 }, (_, index) => ({ ...panel, id: `panel-${String(index)}` }));
  assert.ok(!valid({ v: '1', panels }));
  assert.ok(valid({ v: '1', panels: panels.slice(0, 8) }));
  const renderers = Array.from({ length: 17 }, (_, index) => ({ ...renderer, kind: `kind-${String(index)}` }));
  assert.ok(!valid({ v: '1', renderers }));
});
