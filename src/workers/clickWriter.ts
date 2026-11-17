import { type ClickEvent, parseClickEvent } from '../analytics/clickEvent.js';
import type { Queryable } from '../db/pool.js';
import { clickEventsInvalidTotal, clicksWrittenTotal } from '../observability/metrics.js';

/**
 * Batch-inserts click events. Idempotent: `ON CONFLICT DO NOTHING` on (event_id, ts)
 * absorbs Kafka redeliveries, and clicks for URLs deleted in the meantime are skipped
 * instead of failing the whole batch on the foreign key.
 */
export class ClickWriter {
  constructor(
    private readonly db: Queryable,
    private readonly chunkSize = 1000,
  ) {}

  async write(events: ClickEvent[]): Promise<number> {
    let inserted = 0;

    for (let start = 0; start < events.length; start += this.chunkSize) {
      const chunk = events.slice(start, start + this.chunkSize);
      const result = await this.db.query(
        `INSERT INTO clicks (event_id, url_id, ts, referrer, ip_hash)
         SELECT e.event_id, e.url_id, e.ts, e.referrer, e.ip_hash
         FROM unnest($1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[], $5::text[])
           AS e(event_id, url_id, ts, referrer, ip_hash)
         WHERE EXISTS (SELECT 1 FROM urls u WHERE u.id = e.url_id)
         ON CONFLICT DO NOTHING`,
        [
          chunk.map((event) => event.eventId),
          chunk.map((event) => event.urlId),
          chunk.map((event) => event.ts),
          chunk.map((event) => event.referrer),
          chunk.map((event) => event.ipHash),
        ],
      );
      inserted += result.rowCount ?? 0;
    }

    clicksWrittenTotal.inc(inserted);
    return inserted;
  }
}

/** Parses raw Kafka messages, skips malformed ones, and writes the rest. */
export async function processClickMessages(
  messages: { value: Buffer | null }[],
  writer: Pick<ClickWriter, 'write'>,
): Promise<{ written: number; invalid: number }> {
  const events: ClickEvent[] = [];
  let invalid = 0;

  for (const message of messages) {
    const event = parseClickEvent(message.value);
    if (event) {
      events.push(event);
    } else {
      invalid += 1;
    }
  }

  if (invalid > 0) {
    clickEventsInvalidTotal.inc(invalid);
  }

  const written = events.length > 0 ? await writer.write(events) : 0;
  return { written, invalid };
}
