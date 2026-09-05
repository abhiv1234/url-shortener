import { describe, expect, it } from 'vitest';
import { isValidCustomAlias, isValidLongUrl } from '../src/utils/validate.js';

describe('isValidLongUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidLongUrl('http://example.com/path')).toBe(true);
    expect(isValidLongUrl('https://example.com/very/long/path')).toBe(true);
  });

  it('rejects invalid schemes and malformed URLs', () => {
    expect(isValidLongUrl('ftp://example.com')).toBe(false);
    expect(isValidLongUrl('not-a-url')).toBe(false);
    expect(isValidLongUrl('')).toBe(false);
  });
});

describe('isValidCustomAlias', () => {
  it('accepts valid aliases', () => {
    expect(isValidCustomAlias('my-link')).toBe(true);
    expect(isValidCustomAlias('abc_123')).toBe(true);
    expect(isValidCustomAlias('a1b')).toBe(true);
  });

  it('rejects aliases outside length or charset rules', () => {
    expect(isValidCustomAlias('ab')).toBe(false);
    expect(isValidCustomAlias('a'.repeat(17))).toBe(false);
    expect(isValidCustomAlias('bad alias')).toBe(false);
    expect(isValidCustomAlias('bad!alias')).toBe(false);
  });
});
