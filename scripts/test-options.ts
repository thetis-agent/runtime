/** Partition the complete discovered suite without sharing a sandbox between shards; ADR 0012, ADR 0035. */
export const maximumShards = 16;
export interface TestOptions { coverage?: string; shard?: { index: number; count: number }; prefixes: string[] }

export function testOptions(args: string[]): TestOptions {
  const options: TestOptions = { prefixes: [] };
  for (let at = 0; at < args.length; at++) {
    const argument = args[at];
    if (argument === '--delegated') continue;
    if (argument === '--coverage') {
      const path = args[++at];
      if (options.coverage || !path || path.startsWith('--')) throw new Error('--coverage requires one output directory.');
      options.coverage = path;
    } else if (argument === '--shard') {
      const match = /^(\d+)\/(\d+)$/u.exec(args[++at] ?? '');
      const index = Number(match?.[1]); const count = Number(match?.[2]);
      if (options.shard || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count || count > maximumShards) {
        throw new Error(`--shard requires one index/count with 1 <= index <= count <= ${String(maximumShards)}.`);
      }
      options.shard = { index, count };
    } else if (!argument || argument.startsWith('--')) throw new Error(`Unknown test option: ${String(argument)}`);
    else options.prefixes.push(argument);
  }
  return options;
}

export function shardTests(tests: string[], shard: TestOptions['shard']): string[] {
  return tests.toSorted().filter((_, index) => !shard || index % shard.count === shard.index - 1);
}
