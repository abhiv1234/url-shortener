import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies sensible defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.kafka.brokers).toEqual(['localhost:9092']);
    expect(config.kafka.clickTopicPartitions).toBe(6);
    expect(config.rateLimit.create).toEqual({ max: 100, timeWindowMs: 3_600_000 });
    expect(config.rateLimit.redirect).toEqual({ max: 1000, timeWindowMs: 60_000 });
  });

  it('parses lists, booleans and strips a trailing slash from the base URL', () => {
    const config = loadConfig({
      KAFKA_BROKERS: 'a:9092, b:9092',
      KAFKA_ENABLED: 'false',
      RATE_LIMIT_ENABLED: '0',
      SHORT_URL_BASE: 'https://sho.rt/',
    });
    expect(config.kafka.brokers).toEqual(['a:9092', 'b:9092']);
    expect(config.kafka.enabled).toBe(false);
    expect(config.rateLimit.enabled).toBe(false);
    expect(config.shortUrlBase).toBe('https://sho.rt');
  });

  it('refuses to start in production with default or weak secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), IP_HASH_SALT: 'short' }),
    ).toThrow(/IP_HASH_SALT/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), IP_HASH_SALT: 'y'.repeat(32) }),
    ).not.toThrow();
  });

  it('rejects malformed numbers', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
  });
});
