/** Validate a merged LCOV report with the same bounds and attribution as a single run; ADR 0035. */
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { prepareCoverage, writeCoverage } from '@/scripts/coverage.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output, 'lcov.info')) throw new Error('Provide separate input LCOV and output report paths.');
await prepareCoverage(output);
// LCOV canonicalises portable source names against the aggregate job workspace.
await writeCoverage(createReadStream(input), output, process.cwd());
