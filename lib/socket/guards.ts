/** Distinguish validated open frame variants without trusting extension fields; KS-021. */
import type { Frame, Response, Note } from '@/contracts/kernel-socket/types.ts';
import { isObject } from '@/lib/schema/index.ts';

export function response(frame: Frame): frame is Response {
  if (typeof frame['id'] !== 'string') return false;
  return Object.hasOwn(frame, 'result') || isObject(frame['error']) && typeof frame['error']['code'] === 'string' && typeof frame['error']['message'] === 'string';
}

export function note(frame: Frame): frame is Note {
  return frame['note'] === 'turn.report' || frame['note'] === 'env.updated' || frame['note'] === 'run.stop' || frame['note'] === 'notice';
}
