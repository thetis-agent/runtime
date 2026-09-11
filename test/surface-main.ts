/** Serve the real web surface to a browser on this machine, against the mock provider; ADR 0009, ADR 0038.
 *
 * Everything below the proxy is the same trio `packages/gateway-web/service.test.ts` already builds —
 * a shared provider, one person's environment, and that person's gateway — so what a browser sees here
 * is what the gateway actually serves, not a mock of it. The one thing this adds is reachability: the
 * gateway listens on a Unix socket inside a sandbox, and a browser cannot open one.
 *
 * The proxy signs the browser in by writing the fixture's own session cookie onto the first request of
 * every connection. That is a deliberate convenience for looking at the surface and it is why this file
 * binds to the loopback address and refuses to be told otherwise: anything reaching this port is already
 * signed in as the fixture person, so it must never be reachable from off the machine.
 */
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { serviceFixture } from '@/test/provider-service.ts';
import { environmentProcess } from '@/test/environment-process.ts';
import { gatewayProcess } from '@/test/gateway-process.ts';

const limits = { headerBytes: 16384, backlog: 64 };
const headerEnd = Buffer.from('\r\n\r\n');

/* One turn's worth of provider output per entry, replayed in order across the conversation's turns.
 * Written to exercise every projection the surface draws rather than to be interesting: reasoning
 * deltas, a tool call and its answer, usage counters, and enough text to batch. */
const scripts = [
  [
    { type: 'delta.reasoning', text: 'The person is asking what is here. Listing the space answers it directly.' },
    { type: 'delta.text', text: 'Let me look at what is in your space.\n\n' },
    { type: 'delta.tool_call', callId: 'call-1', name: 'list_path', args: '{"path":"/space"}' },
    { type: 'usage', counters: { cost: 0.0009, input: 1840, output: 96 } },
    { type: 'stop', reason: 'tool_calls' }
  ],
  [
    { type: 'delta.text', text: 'Your space is empty right now — nothing has been written to it yet.\n\n' },
    { type: 'delta.text', text: 'Here is how the pieces fit together:\n\n```mermaid\ngraph LR\n  A[you] --> B[gateway]\n  B --> C[environment]\n  C --> D[model]\n```\n' },
    { type: 'usage', counters: { cost: 0.0014, input: 2380, output: 214 } },
    { type: 'stop', reason: 'end' }
  ]
];

/** Rewrite the first request of a connection to carry the fixture's cookie, then get out of the way.
 *
 * Only the first request is touched: a browser that has been handed a cookie sends it itself, and a
 * WebSocket upgrade is one request followed by frames this must not read. Anything whose headers do not
 * arrive within the bound is passed through untouched rather than buffered without end. */
function inject(client: Socket, cookie: string, path: string): void {
  const upstream = createConnection(path);
  let buffered = Buffer.alloc(0); let forwarding = false;
  const fail = (): void => { client.destroy(); upstream.destroy(); };
  client.on('error', fail); upstream.on('error', fail);
  upstream.on('close', () => { client.destroy(); });
  upstream.pipe(client);
  client.on('data', (chunk: Buffer) => {
    if (forwarding) { upstream.write(chunk); return; }
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(headerEnd);
    if (end === -1) { if (buffered.length > limits.headerBytes) { forwarding = true; upstream.write(buffered); } return; }
    forwarding = true;
    const head = buffered.subarray(0, end).toString('latin1');
    const rest = buffered.subarray(end + headerEnd.length);
    const lines = head.split('\r\n').filter(line => !/^cookie\s*:/iu.test(line));
    upstream.write(`${[...lines, `cookie: ${cookie}`].join('\r\n')}\r\n\r\n`);
    if (rest.length) upstream.write(rest);
  });
  client.on('close', () => { upstream.destroy(); });
}

const port = Number(process.argv[2] ?? '8787');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Provide a loopback port between 1024 and 65535.');

/* A development budget, not a realistic one: the fixture's rule caps the whole run and a turn is
 * estimated at the mock's ceiling before it starts, so a small cap stops the second turn rather than
 * the tenth. */
const shared = await serviceFixture(1000, { scripts, maximumCost: 0.01 });
const environment = await environmentProcess(shared, 'alice', true);
const gateway = await gatewayProcess(shared, environment, 'alice', 'gateway-web', [], 'service.ts', {},
  ['inspector-context', 'inspector-tools', 'skills-l1']);
const cookie = `thetis_session=${shared.mintSession('alice')}`;

const proxy = createServer(client => { inject(client, cookie, gateway.socket); });
proxy.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
await new Promise<void>(resolve => { proxy.listen(port, '127.0.0.1', limits.backlog, resolve); });
process.stdout.write(`${JSON.stringify({ surface: 'listening', url: `http://127.0.0.1:${String(port)}/`, person: 'alice' })}\n`);

const stop = async (): Promise<void> => {
  proxy.close();
  await gateway.close(); await environment.close(); await shared.close();
  process.exit(0);
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await new Promise(() => { /* serve until signalled */ });
