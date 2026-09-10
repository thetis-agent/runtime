/** Keep the package import gate effective across repository layouts; ADR 0035, ADR 0002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

await test('ADR 0035 package imports allow shared modules and refuse sibling package implementations', async () => {
  const lint = new ESLint();
  for (const [source, refused] of [
    ['./model.ts', false], ['@/lib/schema/index.ts', false], ['@/contracts/provider/types.ts', false],
    ['@/packages/provider-mock/index.ts', true], ['@/kernel/secrets/index.ts', true], ['@/scripts/build.ts', true], ['../../lib/schema/index.ts', false], ['../../contracts/provider/types.ts', false],
    ['../provider-mock/index.ts', true], ['../provider-mock/startup.ts', true],
    ['../../packages/provider-mock/index.ts', true], ['@thetis/package-provider-mock', true], ['#packages/provider-mock/index.ts', true]
  ] satisfies [string, boolean][]) {
    const results = await lint.lintText(`import '${source}';`, { filePath: 'packages/core/index.ts' });
    assert.equal(results.some(result => result.messages.some(message => message.ruleId === 'no-restricted-imports')), refused, source);
    assert.equal(results.some(result => result.fatalErrorCount !== 0), false, source);
  }
});
