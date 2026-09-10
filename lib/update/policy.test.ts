/** Pin the fix/improvement selection boundaries and the refusals that keep an Update from crossing a major or going backward. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select } from './policy.ts';

await test('The current version is never reselected', () => {
  assert.equal(select('v1.2.3', ['v1.2.3'], 'improvements'), undefined);
});

await test('A lower tag is never selected as a downgrade', () => {
  assert.equal(select('v1.2.3', ['v1.2.2', 'v1.0.0'], 'improvements'), undefined);
});

await test('Fixes selects a same-minor patch bump', () => {
  assert.equal(select('v1.2.3', ['v1.2.4'], 'fixes'), 'v1.2.4');
});

await test('Fixes never crosses a minor, but improvements does', () => {
  assert.equal(select('v1.2.3', ['v1.3.0'], 'fixes'), undefined);
  assert.equal(select('v1.2.3', ['v1.3.0'], 'improvements'), 'v1.3.0');
});

await test('No policy ever selects a different major version', () => {
  assert.equal(select('v1.2.3', ['v2.0.0'], 'fixes'), undefined);
  assert.equal(select('v1.2.3', ['v2.0.0'], 'improvements'), undefined);
});

await test('A prerelease or build-metadata tag is never selected', () => {
  assert.equal(select('v1.2.3', ['v1.2.4-rc.1'], 'improvements'), undefined);
  assert.equal(select('v1.2.3', ['v1.2.4+build.5'], 'improvements'), undefined);
});

await test('Policy none selects nothing under any input, including a valid higher tag', () => {
  assert.equal(select('v1.2.3', ['v1.2.4', 'v1.9.9'], 'none'), undefined);
});

await test('The highest eligible candidate wins among several', () => {
  assert.equal(select('v1.2.3', ['v1.2.4', 'v1.2.9', 'v1.2.5'], 'fixes'), 'v1.2.9');
  assert.equal(select('v1.2.3', ['v1.3.0', 'v1.9.9', 'v1.4.0'], 'improvements'), 'v1.9.9');
});

await test('Invalid or malformed tags are ignored rather than thrown', () => {
  assert.equal(select('v1.2.3', ['not-a-version', 'v1.2', 'v01.2.4', 'v1.2.4'], 'improvements'), 'v1.2.4');
});

await test('An invalid current version selects nothing', () => {
  assert.equal(select('not-a-version', ['v1.2.4'], 'improvements'), undefined);
});
