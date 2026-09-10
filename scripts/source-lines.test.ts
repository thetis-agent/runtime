/** Keep comment exclusion from hiding code or treating literal text as comments; ADR 0039. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceLines } from '@/scripts/source-lines.ts';

await test('ADR 0039 excludes comment-only lines and retains blank and mixed code lines', () => {
  const text = '/** Defence.\n * More context.\n\n */\n\nconst value = 1; // explanation\n/* context */ value++;\n// end';
  assert.deepEqual(sourceLines(text), { physicalLines: 8, commentLines: 5, lines: 3 });
  assert.deepEqual(sourceLines(''), { physicalLines: 0, commentLines: 0, lines: 0 });
  assert.deepEqual(sourceLines('\n'), { physicalLines: 1, commentLines: 0, lines: 1 });
  assert.deepEqual(sourceLines('// comment\r\nconst x = 1;\r\n'), { physicalLines: 2, commentLines: 1, lines: 1 });
  assert.deepEqual(sourceLines('// first\r// second\r'), { physicalLines: 2, commentLines: 2, lines: 0 });
});

await test('ADR 0039 preserves comment markers in strings, regexes and interpolated template bodies', () => {
  const text = [
    'const url = "https://example.test/*path*/";',
    'const expression = /[/*]foo[//]/;',
    'const template = `first',
    '// literal line',
    '${',
    '// actual comment inside an expression',
    '1 /* inline comment */',
    '} /* literal tail */',
    '// still literal',
    '`;',
    '// actual final comment'
  ].join('\n');
  assert.deepEqual(sourceLines(text), { physicalLines: 11, commentLines: 2, lines: 9 });
});
