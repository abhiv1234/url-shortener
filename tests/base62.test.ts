import { describe, expect, it } from 'vitest';
import { encodeBase62 } from '../src/utils/base62.js';

describe('encodeBase62', () => {
  it('encodes zero as the first charset character', () => {
    expect(encodeBase62(0)).toBe('0');
  });

  it('encodes small integers', () => {
    expect(encodeBase62(1)).toBe('1');
    expect(encodeBase62(61)).toBe('z');
    expect(encodeBase62(62)).toBe('10');
  });

  it('encodes the architecture example', () => {
    expect(encodeBase62(1_000_000)).toBe('4C92');
  });

  it('supports bigint input', () => {
    expect(encodeBase62(62n)).toBe('10');
  });

  it('rejects negative integers', () => {
    expect(() => encodeBase62(-1)).toThrow('positive integer');
  });
});
