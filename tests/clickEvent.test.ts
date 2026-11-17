import { describe, expect, it } from 'vitest';
import {
  buildClickEvent,
  hashIp,
  parseClickEvent,
  serializeClickEvent,
} from '../src/analytics/clickEvent.js';

describe('click events', () => {
  const now = new Date('2026-09-05T08:00:00.000Z');

  it('hashes IPs with the salt and never exposes the raw IP', () => {
    const event = buildClickEvent({ urlId: '42', ip: '203.0.113.7', referrer: undefined, salt: 's1', now });
    expect(event.ipHash).toBe(hashIp('203.0.113.7', 's1'));
    expect(event.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toContain('203.0.113.7');
    expect(hashIp('203.0.113.7', 's2')).not.toBe(event.ipHash);
  });

  it('round-trips through serialize and parse', () => {
    const event = buildClickEvent({
      urlId: '9007199254740993',
      ip: '::1',
      referrer: 'https://google.com',
      salt: 'salt',
      now,
    });
    expect(parseClickEvent(Buffer.from(serializeClickEvent(event)))).toEqual(event);
  });

  it('normalises empty referrers to null and truncates very long ones', () => {
    expect(buildClickEvent({ urlId: '1', ip: undefined, referrer: '  ', salt: 's' }).referrer).toBeNull();
    const long = buildClickEvent({ urlId: '1', ip: undefined, referrer: `https://x.com/${'a'.repeat(5000)}`, salt: 's' });
    expect(long.referrer).toHaveLength(2048);
    expect(long.ipHash).toBeNull();
  });

  it('rejects malformed payloads', () => {
    const valid = buildClickEvent({ urlId: '1', ip: '1.1.1.1', referrer: undefined, salt: 's', now });
    expect(parseClickEvent(null)).toBeNull();
    expect(parseClickEvent('not json')).toBeNull();
    expect(parseClickEvent('[]')).toBeNull();
    expect(parseClickEvent(JSON.stringify({ ...valid, urlId: 42 }))).toBeNull();
    expect(parseClickEvent(JSON.stringify({ ...valid, urlId: '0' }))).toBeNull();
    expect(parseClickEvent(JSON.stringify({ ...valid, eventId: 'nope' }))).toBeNull();
    expect(parseClickEvent(JSON.stringify({ ...valid, ts: 'yesterday' }))).toBeNull();
    expect(parseClickEvent(JSON.stringify({ ...valid, ipHash: '1.1.1.1' }))).toBeNull();
  });
});
