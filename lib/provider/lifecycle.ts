/** Preserve provider error codes on the shared service lifecycle; PR-001, ADR 0010. */
import { Service as Lifecycle, serviceLimits } from '@/lib/service/lifecycle.ts';
import type { Clock } from '@/lib/events/index.ts';
export { serviceLimits } from '@/lib/service/lifecycle.ts';
export type { Connection } from '@/lib/service/lifecycle.ts';
export class Service extends Lifecycle<'provider'> {
  constructor(clock: Clock, limits = serviceLimits) { super(clock, limits, 'provider'); }
}
