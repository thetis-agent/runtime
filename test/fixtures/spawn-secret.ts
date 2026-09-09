/** Verify spawn delivery without printing the delivered value; PR-013. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const value = process.env['VENDOR_API_KEY']; const expected = process.argv[2];
let exposed = false;
if (value) for (const path of ['/proc/self/cmdline', '/proc/self/environ', '/thetis-bootstrap.ts', '/entry.ts']) {
  exposed ||= (await readFile(path)).includes(Buffer.from(value));
}
process.stdout.write(JSON.stringify({ delivered: value !== undefined && createHash('sha256').update(value).digest('hex') === expected, exposed, importedWithSecret: value !== undefined }));
