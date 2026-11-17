/**
 * Click pipeline against a real Kafka broker:
 *   BufferedClickPublisher → Kafka → consumer group → ClickWriter → Postgres.
 *
 *   INTEGRATION=1 INTEGRATION_KAFKA=1 KAFKA_BROKERS=localhost:9092 DATABASE_URL=... npm run test:integration
 *
 * Uses a throwaway topic and consumer group per run (deleted afterwards).
 * WARNING: truncates the clicks/urls/users tables — use a disposable database.
 */
import { randomUUID } from 'node:crypto';
import type { Consumer, Kafka, Producer } from 'kafkajs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClickEvent, serializeClickEvent } from '../../src/analytics/clickEvent.js';
import { BufferedClickPublisher } from '../../src/analytics/clickPublisher.js';
import { createClickProducer, createKafka, ensureTopic } from '../../src/analytics/kafka.js';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { ClickWriter, processClickMessages } from '../../src/workers/clickWriter.js';

const enabled = process.env.INTEGRATION === '1' && process.env.INTEGRATION_KAFKA === '1';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

async function eventually(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe.skipIf(!enabled)('click pipeline against real Kafka', () => {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const topic = `click-events-it-${randomUUID().slice(0, 8)}`;
  const groupId = `click-writer-it-${randomUUID().slice(0, 8)}`;

  let pool: pg.Pool;
  let kafka: Kafka;
  let publisher: BufferedClickPublisher;
  let rawProducer: Producer;
  let consumer: Consumer;
  let urlId: string;
  let invalidSeen = 0;

  const clickCount = async () =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM clicks WHERE url_id = $1', [urlId])).rows[0].n;

  beforeAll(async () => {
    pool = createPool(config.databaseUrl);
    await migrate(pool, () => undefined);
    await pool.query('TRUNCATE clicks, urls, users RESTART IDENTITY CASCADE');
    urlId = (
      await pool.query<{ id: string }>(
        "INSERT INTO urls (short_code, long_url) VALUES ('kafka-it', 'https://example.com') RETURNING id",
      )
    ).rows[0].id;

    kafka = createKafka({ ...config.kafka, clientId: 'url-shortener-it' }, silent);
    await ensureTopic(kafka, topic, 3);

    const writer = new ClickWriter(pool);
    consumer = kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        const result = await processClickMessages(batch.messages, writer);
        invalidSeen += result.invalid;
        const last = batch.messages.at(-1);
        if (last) resolveOffset(last.offset);
        await heartbeat();
      },
    });

    publisher = new BufferedClickPublisher(createClickProducer(kafka), {
      topic,
      batchSize: 20,
      logger: silent,
    });
    await publisher.start();
    await eventually(async () => publisher.isConnected());

    rawProducer = createClickProducer(kafka);
    await rawProducer.connect();
  }, 60_000);

  afterAll(async () => {
    await publisher?.close();
    await rawProducer?.disconnect();
    await consumer?.disconnect();
    const admin = kafka?.admin();
    if (admin) {
      await admin.connect();
      await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
      await admin.deleteGroups([groupId]).catch(() => undefined);
      await admin.disconnect();
    }
    await pool?.end();
  });

  it('delivers every published click to Postgres exactly once, skipping malformed messages', async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      buildClickEvent({ urlId, ip: `10.0.0.${i}`, referrer: i % 2 ? 'https://t.co' : undefined, salt: 'it' }),
    );

    for (const event of events) publisher.publish(event);
    await publisher.flush();

    // A redelivered event and a garbage payload must neither double-count nor stall the consumer.
    await rawProducer.send({
      topic,
      messages: [
        { key: urlId, value: serializeClickEvent(events[0]) },
        { key: urlId, value: 'not json' },
      ],
    });

    await eventually(async () => (await clickCount()) >= 50 && invalidSeen >= 1);
    // Give any (incorrect) duplicate insert a moment to show up before asserting.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(await clickCount()).toBe(50);
    expect(invalidSeen).toBe(1);

    const { rows } = await pool.query<{ referred: number; hashed: boolean }>(
      `SELECT count(*) FILTER (WHERE referrer = 'https://t.co')::int AS referred,
              bool_and(ip_hash ~ '^[0-9a-f]{64}$') AS hashed
       FROM clicks WHERE url_id = $1`,
      [urlId],
    );
    expect(rows[0]).toEqual({ referred: 25, hashed: true });
  }, 60_000);
});
