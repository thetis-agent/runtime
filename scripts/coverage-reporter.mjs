/** Give Node's LCOV functions stable source identities across shards; ADR 0035. */
import { compose } from 'node:stream';
import { lcov } from 'node:test/reporters';

async function* functions(source) {
  for await (const event of source) {
    if (event.type === 'test:coverage') {
      for (const file of event.data.summary.files) {
        const seen = new Map();
        for (const fn of file.functions) {
          // Native LCOV uses bare names, conflating methods such as two classes' `close`.
          // Anonymous names based on the array index also change as lazy functions appear.
          const key = `${fn.name || '(anonymous)'}@${fn.line}`;
          const index = seen.get(key) || 0;
          seen.set(key, index + 1);
          fn.name = `${key}#${index}`;
        }
      }
    }
    yield event;
  }
}

export default async function* reporter(source) {
  yield* compose(source, functions, new lcov());
}
