/** Touch enough pages to exercise the kernel's real memory ceiling; ADR 0005 §4. */
const bytes = Buffer.alloc(256 * 1024 * 1024, 1);
process.stdout.write(String(bytes.length));
