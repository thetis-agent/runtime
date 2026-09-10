/** Take an administrator's password from a private descriptor or a terminal with echo off, never from a command line; ADR 0048. */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';

export const passwordLimits = { bytes: 1024, minimumLength: 12 };

async function bounded(stream: AsyncIterable<Buffer | string>): Promise<Result<string>> {
  const chunks: string[] = []; let bytes = 0;
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(text); if (bytes > passwordLimits.bytes) return failure('budget', 'The password exceeds its byte budget.');
    chunks.push(text);
    if (text.includes('\n')) break;
  }
  return { ok: true, value: chunks.join('').split('\n')[0] ?? '' };
}

function echo(enabled: boolean): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/stty', [enabled ? 'echo' : '-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
    child.once('error', () => { resolve(); }); child.once('close', () => { resolve(); });
  });
}

async function terminal(): Promise<Result<string>> {
  process.stderr.write('Administrator password: ');
  await echo(false);
  try { return await bounded(process.stdin); }
  finally { await echo(true); process.stderr.write('\n'); }
}

export async function readPassword(descriptor?: number): Promise<Result<string>> {
  const read = descriptor === undefined
    ? process.stdin.isTTY ? await terminal() : failure('invalid-args', 'A password needs --password-fd when no terminal is attached.')
    : await bounded(createReadStream('', { fd: descriptor, autoClose: true }));
  if (!read.ok) return read;
  return read.value.length >= passwordLimits.minimumLength
    ? { ok: true, value: read.value }
    : failure('invalid-args', `An administrator password is at least ${String(passwordLimits.minimumLength)} characters.`);
}
