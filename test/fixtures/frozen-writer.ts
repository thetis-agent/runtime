/** Exercise freezer behavior through queued socket input rather than elapsed time; GN-002. */
import { writeFile } from 'node:fs/promises';
import { authority } from '../../lib/sandbox-runner/authority.ts';

const received = await authority();
if (!received.ok) { process.exitCode = 1; }
else {
  const socket = received.value.socket; let writes = 0;
  socket.write('ready\n');
  for await (const chunk of socket) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value) || value.length > 64) throw new Error('The writer probe input is invalid.');
    await writeFile('/work/value', String(++writes)); socket.write(`${String(writes)}\n`);
    if (writes === 2) { socket.end(); break; }
  }
}
