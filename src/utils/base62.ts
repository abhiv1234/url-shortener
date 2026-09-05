const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;

export function encodeBase62(value: number | bigint): string {
  let n = typeof value === 'bigint' ? value : BigInt(value);

  if (n < 0n) {
    throw new Error('Base62 encoding requires a positive integer');
  }

  if (n === 0n) {
    return CHARSET[0];
  }

  let result = '';
  while (n > 0n) {
    const remainder = Number(n % BASE);
    result = CHARSET[remainder] + result;
    n /= BASE;
  }

  return result;
}
