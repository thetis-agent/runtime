/** Inspect only private network metadata and test an explicitly supplied loopback fixture; ADR 0029. */
import { readFile, readlink, access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
const port = Number(process.argv[2]);
const connected = await new Promise<boolean>(resolve => {
  const socket = createConnection({ host: '10.0.2.2', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
});
let tun = false; try { await access('/dev/net/tun'); tun = true; } catch { tun = false; }
let resolver = ''; try { resolver = await readFile('/etc/resolv.conf', 'utf8'); } catch { resolver = ''; }
process.stdout.write(`${JSON.stringify({ namespace: await readlink('/proc/self/ns/net'), interfaces: Object.keys(networkInterfaces()), route: await readFile('/proc/net/route', 'utf8'), resolver, connected, tun })}\n`);
