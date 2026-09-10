/** Keep secret entry and confirmation codes on the authenticated kernel origin; ADR 0018 §3–4, KS-015. */
import { createServer } from 'node:http';
import { body, reply } from '@/lib/http/index.ts';
import type { Server } from 'node:http';
import type { Identity } from '@/kernel/identity/index.ts';
import type { Secrets } from '@/kernel/secrets/index.ts';
import type { Act } from '@/kernel/generations/act.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Schemas } from '@/lib/schema/index.ts';
import type { DefaultPrepareParams, DefaultSetParams, SecretSetParams } from '@/contracts/kernel-socket/types.ts';

export const originLimits = { bytes: 32768, headersBytes: 16384, connections: 64, deadlineMs: 10000 };
export interface OriginContext { origin: string; identity: Identity; secrets: Secrets; act: Act; schemas: Schemas }

export function origin(context: OriginContext): Server {
  const reference = 'thetis://contract/kernel-socket/1#/$defs/params/';
  const prepare = context.schemas.compile<DefaultPrepareParams>({ $ref: `${reference}default.prepare` });
  const set = context.schemas.compile<DefaultSetParams>({ $ref: `${reference}default.set` });
  const secret = context.schemas.compile<SecretSetParams>({ $ref: `${reference}secret.set` });
  const session = context.schemas.compile<{ sessionToken: string }>({ type: 'object', properties: { sessionToken: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['sessionToken'] });
  const server = createServer({ maxHeaderSize: originLimits.headersBytes, requestTimeout: originLimits.deadlineMs, headersTimeout: originLimits.deadlineMs });
  server.maxConnections = originLimits.connections; server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('request', (request, response) => {
    const handle = async (): Promise<void> => {
      if (request.method !== 'POST' || request.headers.origin !== context.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') { reply(response, failure('forbidden', 'The act requires a JSON request from the kernel origin.')); return; }
      const input = await body(request, originLimits.bytes, 'The kernel origin request'); if (!input.ok) { reply(response, input); return; }
      if (request.url === '/session') {
        if (!session(input.value)) { reply(response, failure('invalid-args', 'The identity session violates its schema.')); return; }
        const resolved = context.identity.resolveSession(input.value.sessionToken); if (!resolved.ok) { reply(response, resolved); return; }
        response.setHeader('set-cookie', `__Host-thetis=${input.value.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict`);
        reply(response, { ok: true, value: { person: resolved.value.id, role: resolved.value.role } }); return;
      }
      const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-thetis='))?.slice('__Host-thetis='.length) ?? '';
      const person = context.identity.resolveSession(token); if (!person.ok) { reply(response, person); return; }
      if (request.url === '/default.prepare' && prepare(input.value)) {
        const result = context.act.prepare(person.value, 'kernel', input.value);
        if (!result.ok) { reply(response, result); return; }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", connection: 'close' }); response.end(`${result.value.line}\n`); return;
      }
      const result = request.url === '/default.set' && set(input.value) ? await context.act.set(person.value, 'kernel', input.value)
        : request.url === '/secret.set' && secret(input.value) ? await context.secrets.set(person.value, 'kernel', input.value)
        : failure('invalid-args', 'The kernel origin operation or its parameters are invalid.');
      reply(response, result);
    };
    void handle().catch(() => { if (!response.headersSent) reply(response, failure('io', 'The kernel origin request could not complete.')); else response.destroy(); });
  });
  return server;
}
