/** Preserve every finite decimal price exactly through admission and settlement; ADR 0044, PR-010. */
const precision = 324;
const units = 10n ** BigInt(precision);

export function money(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error('Provider cost must be finite and nonnegative.');
  const [mantissa, exponent = '0'] = value.toString().split('e');
  if (!mantissa) throw new Error('A validated cost lost its decimal representation.');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  return BigInt(whole + fraction) * 10n ** BigInt(precision + Number(exponent) - fraction.length);
}

export function decimal(value: bigint): string {
  if (value < 0n) throw new Error('A provider balance became negative.');
  const fraction = (value % units).toString().padStart(precision, '0').replace(/0+$/u, '');
  return `${String(value / units)}${fraction ? `.${fraction}` : ''}`;
}

export function balance(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * units + BigInt(fraction.padEnd(precision, '0'));
}
