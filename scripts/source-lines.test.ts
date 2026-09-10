/** Exclude import and formatting lines without hiding executable code or literal contents; ADR 0039, ADR 0051. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceLines } from '@/scripts/source-lines.ts';

await test('ADR 0051 excludes comments and whitespace while retaining mixed code lines', () => {
  const text = '/** Defence.\n * More context.\n\n */\n\nconst value = 1; // explanation\n/* context */ value++;\n// end';
  assert.deepEqual(sourceLines(text), { physicalLines: 8, commentLines: 4, importLines: 0, blankLines: 2, lines: 2 });
  assert.deepEqual(sourceLines(''), { physicalLines: 0, commentLines: 0, importLines: 0, blankLines: 0, lines: 0 });
  assert.deepEqual(sourceLines('\n'), { physicalLines: 1, commentLines: 0, importLines: 0, blankLines: 1, lines: 0 });
  assert.deepEqual(sourceLines('// comment\r\nconst x = 1;\r\n'), { physicalLines: 2, commentLines: 1, importLines: 0, blankLines: 0, lines: 1 });
  assert.deepEqual(sourceLines('// first\r// second\r'), { physicalLines: 2, commentLines: 2, importLines: 0, blankLines: 0, lines: 0 });
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
  assert.deepEqual(sourceLines(text), { physicalLines: 11, commentLines: 2, importLines: 0, blankLines: 0, lines: 9 });
});

await test('ADR 0051 excludes complete static imports but counts dynamic imports, re-exports and same-line implementation', () => {
  const text = [
    '// module defence',
    'import type {',
    '  First,',
    '  /* import documentation */ Second',
    '} from "./types.ts";',
    'import "./bootstrap.ts";',
    'import legacy = require("legacy");',
    'import settings from "./settings.json" with {',
    '  type: "json"',
    '};',
    'import { value } from "./value.ts"; const result = value;',
    'const pending = import("./dynamic.ts");',
    'type Shape = import("./types.ts").First;',
    'export { value } from "./value.ts";',
    'const text = "import hidden from source";',
    '   '
  ].join('\r\n');
  assert.deepEqual(sourceLines(text), { physicalLines: 16, commentLines: 1, importLines: 9, blankLines: 1, lines: 5 });
});

await test('ADR 0051 classifies blank import, comment and template lines exactly once across newline styles', () => {
  const text = ['import {', '  ', '  value', '} from "./value.ts";', '/* comment', '\t', '*/', 'const template = `first', '  ', 'last`;', '\t '].join('\n');
  const expected = { physicalLines: 11, commentLines: 2, importLines: 3, blankLines: 4, lines: 2 };
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    assert.deepEqual(sourceLines(text.replaceAll('\n', newline)), expected);
  }
});
