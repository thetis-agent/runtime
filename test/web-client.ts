/** Exercise the gateway over a real Unix WebSocket and its plain HTTP requests without external network access; ADR 0009, ADR 0038. */
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { WebSocket } from '@/lib/websocket/client.ts';
import { Queue } from '@/lib/events/queue.ts';
import { isObject } from '@/lib/schema/index.ts';

export interface HttpAnswer { status: number; headers: IncomingHttpHeaders; body: string }

/** Perform one plain HTTP request over the gateway's Unix socket, outside the WebSocket wire; ADR 0038 §4. */
export function httpGet(socketPath: string, urlPath: string, options: { cookie?: string; accept?: string; method?: string; prefix?: string } = {}): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
    if (options.accept !== undefined) headers['accept'] = options.accept;
    if (options.prefix !== undefined) headers['x-forwarded-prefix'] = options.prefix;
    const request = httpRequest({ socketPath, path: urlPath, method: options.method ?? 'GET', headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function webClient(path: string, options: { cookie?: string } = {}) {
  const socket = new WebSocket('ws://localhost/ws', { createConnection: () => createConnection(path), maxPayload: 1048576, perMessageDeflate: false, headers: options.cookie === undefined ? {} : { cookie: options.cookie } });
  const queue = new Queue<Record<string, unknown>>({ entries: 512, bytes: 4194304 });
  socket.on('message', data => {
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
    const value: unknown = JSON.parse(text); assert.ok(isObject(value)); assert.ok(queue.push(value, Buffer.byteLength(text)).ok);
  });
  socket.on('close', () => { queue.close(); }); socket.on('error', () => { queue.close(); });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => { resolve(); }); socket.once('error', reject); });
  const iterator = queue[Symbol.asyncIterator]();
  return { socket, send(value: Record<string, unknown>): Promise<void> { return new Promise((resolve, reject) => { socket.send(JSON.stringify(value), error => { if (error) reject(error); else resolve(); }); }); },
    async next() { const result = await iterator.next(); assert.ok(!result.done); return result.value; },
    close() { socket.terminate(); }
  };
}
