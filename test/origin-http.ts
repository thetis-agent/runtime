/** Keep origin tests on a private socket and actual HTTP parsing; KS-015–016. */
import { request } from 'node:http';

export function post(path: string, route: string, input: unknown, origin = 'https://kernel.test', cookie = ''): Promise<{ status: number; text: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath: path, method: 'POST', path: route, headers: { origin, cookie, 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), cookies: response.headers['set-cookie'] ?? [] }); });
    });
    outgoing.once('error', reject); outgoing.end(JSON.stringify(input));
  });
}
