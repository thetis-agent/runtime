/** Keep reservation arithmetic separate from periodic and lifetime policy; ADR 0044, PR-010. */
import { balance, decimal, money } from './money.ts';

export class Balance {
  spent: bigint;
  reserved = 0n;
  active = 0;
  constructor(spent = '0', reserved = '0') { this.spent = balance(spent) + balance(reserved); }

  reserve(maximum: bigint): (actual: number) => void {
    this.reserved += maximum; this.active++;
    let settled = false;
    return actual => {
      if (settled) throw new Error('A provider reservation was settled twice.');
      const charged = money(actual);
      settled = true; this.reserved -= maximum; this.spent += charged; this.active--;
    };
  }

  snapshot(): { spent: string; reserved: string } { return { spent: decimal(this.spent), reserved: decimal(this.reserved) }; }
}
