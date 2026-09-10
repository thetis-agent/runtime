/** Keep a state writer alive until the actual cgroup boundary ends its authority; GN-003. */
import { writeFile } from 'node:fs/promises';
import { authority } from '../../lib/sandbox-runner/authority.ts';
const inherited = await authority();
if (!inherited.ok) throw new Error(inherited.error.message);
await writeFile('/state/value', 'live');
inherited.value.socket.write('ready');
inherited.value.socket.on('data', () => { throw new Error('The orphan fixture must never receive another command.'); });
