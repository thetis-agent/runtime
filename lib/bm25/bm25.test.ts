/** Pin the Legacy ranker's lexical, dense, fusion and hierarchy branches; SK-013. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, lexical, dense, fusion, tokenize } from './index.ts';

await test('BM25 tokenization and deterministic tie ordering match the original ranker', () => {
  assert.deepEqual(tokenize('A database_SQL 7 λ'), ['database', 'sql', 'λ']);
  assert.deepEqual(lexical([{ id: 'b', text: 'database' }, { id: 'a', text: 'database' }], 'database').map(item => item.id), ['a', 'b']);
  assert.deepEqual(lexical([{ id: 'a', text: '' }], 'database'), []);
});

await test('Dense skips incompatible dimensions and fusion weights both ranked lists', () => {
  assert.deepEqual(dense([{ id: 'a', text: '', vector: [1, 0] }, { id: 'b', text: '', vector: [1] }], [1, 0]), [{ id: 'a', score: 1 }]);
  assert.deepEqual(dense([{ id: 'a', text: '', vector: [0, 0] }], [1, 0]), [{ id: 'a', score: 0 }]);
  assert.equal(fusion([{ id: 'dense', score: 1 }], [{ id: 'lexical', score: 1 }], 0.7)[0]?.id, 'dense');
  assert.equal(fusion([{ id: 'dense', score: 1 }], [{ id: 'lexical', score: 1 }], 0)[0]?.id, 'lexical');
});

await test('Whole-corpus, absorption, promotion and disabled absorption preserve the Legacy choices', () => {
  const corpus = [{ id: 'topic', text: 'database' }, { id: 'topic/child', text: 'database query' }, { id: 'other', text: 'unrelated' }];
  assert.equal(rank(corpus, 'anything', 3).length, 3);
  assert.deepEqual(rank(corpus, 'database', 0), []);
  assert.deepEqual(rank(corpus, 'database', 1).map(item => item.id), ['topic']);
  assert.deepEqual(rank(corpus, 'query', 2).map(item => item.id), ['topic/child', 'topic']);
  assert.equal(rank(corpus, 'database query', 1, undefined, 0.7, false)[0]?.id, 'topic/child');
});
