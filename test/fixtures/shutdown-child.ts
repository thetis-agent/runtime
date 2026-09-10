/** Hold a visible resource until the containing generation is fenced; TE-023, ADR 0021. */
import { createServer } from 'node:net';
const server = createServer(() => {});
server.listen('/endpoint/child.sock', () => { process.stdout.write('ready'); });
