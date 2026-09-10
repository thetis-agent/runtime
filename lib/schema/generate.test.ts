/** Defend that a union member of an intersection renders parenthesized: `&` binds tighter than `|`
 * in TypeScript, so an unparenthesized member would silently change which type actually applies;
 * ADR 0006. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './generate.ts';

await test('a oneOf member of an allOf renders wrapped in parentheses, not left to operator precedence', () => {
  const a = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const b = { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false };
  const c = { type: 'object', properties: { c: { type: 'string' } }, required: ['c'], additionalProperties: false };
  const rendered = render({ allOf: [a, { oneOf: [b, c] }] });
  assert.equal(rendered, '{ "a": string; } & ({ "b": string; } | { "c": string; })');
});

await test('a single-member oneOf inside an allOf renders unparenthesized, matching a plain member', () => {
  const a = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const b = { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false };
  assert.equal(render({ allOf: [a, { oneOf: [b] }] }), render({ allOf: [a, b] }));
});
