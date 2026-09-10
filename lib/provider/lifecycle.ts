/** Preserve provider error codes on the shared service lifecycle; PR-001, ADR 0010. */
import { Service as Lifecycle, serviceLimits } from '../service/lifecycle.ts';
import type { Clock } from '../events/index.ts';
export { serviceLimits } from '../service/lifecycle.ts';
export type { Connection } from '../service/lifecycle.ts';
export class Service extends Lifecycle<'provider'> {
  constructor(clock: Clock, limits = serviceLimits) { super(clock, limits, 'provider'); }
}
