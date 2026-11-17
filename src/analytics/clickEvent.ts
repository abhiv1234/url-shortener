import { createHash, randomUUID } from 'node:crypto';

/**
 * Published to Kafka on every redirect. `urlId` is a string because Postgres BIGINT
 * ids can exceed Number.MAX_SAFE_INTEGER; `eventId` lets the worker dedupe redeliveries.
 */
export interface ClickEvent {
  eventId: string;
  urlId: string;
  ts: string;
  referrer: string | null;
  ipHash: string | null;
}

const MAX_REFERRER_LENGTH = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[1-9]\d{0,18}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

export function buildClickEvent(params: {
  urlId: string;
  ip: string | undefined;
  referrer: string | undefined;
  salt: string;
  now?: Date;
}): ClickEvent {
  const referrer = params.referrer?.trim();
  return {
    eventId: randomUUID(),
    urlId: params.urlId,
    ts: (params.now ?? new Date()).toISOString(),
    referrer: referrer ? referrer.slice(0, MAX_REFERRER_LENGTH) : null,
    ipHash: params.ip ? hashIp(params.ip, params.salt) : null,
  };
}

export function serializeClickEvent(event: ClickEvent): string {
  return JSON.stringify(event);
}

/** Returns null for anything that is not a well-formed click event. */
export function parseClickEvent(raw: Buffer | string | null | undefined): ClickEvent | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const event = value as Record<string, unknown>;
  const { eventId, urlId, ts, referrer, ipHash } = event;

  if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) return null;
  if (typeof urlId !== 'string' || !ID_PATTERN.test(urlId)) return null;
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
  if (referrer !== null && typeof referrer !== 'string') return null;
  if (ipHash !== null && (typeof ipHash !== 'string' || !HASH_PATTERN.test(ipHash))) return null;

  return {
    eventId,
    urlId,
    ts: new Date(ts).toISOString(),
    referrer: referrer ? referrer.slice(0, MAX_REFERRER_LENGTH) : null,
    ipHash,
  };
}
