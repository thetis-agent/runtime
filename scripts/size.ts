/** Enforce the trusted source budget while reporting excluded documentation, imports and whitespace; ADR 0039, ADR 0051, proposal §10. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceLines } from '@/scripts/source-lines.ts';
const limits = { kernelLines: 1300, entries: 10000, sourceBytes: 16777216 };
const files: (ReturnType<typeof sourceLines> & { path: string; bytes: number })[] = [];
let entries = 0; let bytes = 0;
async function inspect(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (++entries > limits.entries || entry.isSymbolicLink()) throw new Error('The source inventory is not a bounded canonical tree.');
    const path = join(root, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const text = await readFile(path, 'utf8'); bytes += Buffer.byteLength(text);
      if (bytes > limits.sourceBytes) throw new Error('The trusted source exceeds its inventory byte limit.');
      files.push({ path, ...sourceLines(text), bytes: Buffer.byteLength(text) });
    }
  }
}
await inspect(fileURLToPath(new URL('../kernel', import.meta.url)));
const lines = files.reduce((total, file) => total + file.lines, 0);
const physicalLines = files.reduce((total, file) => total + file.physicalLines, 0);
const commentLines = files.reduce((total, file) => total + file.commentLines, 0);
const importLines = files.reduce((total, file) => total + file.importLines, 0);
const blankLines = files.reduce((total, file) => total + file.blankLines, 0);
process.stdout.write(`${JSON.stringify({ measurement: 'kernel-source-size', lines, physicalLines, commentLines, importLines, blankLines, bytes, maximumLines: limits.kernelLines, files })}\n`);
if (lines > limits.kernelLines) process.exitCode = 1;
