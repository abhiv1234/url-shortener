import type { Admin } from 'kafkajs';
import { createKafka, ensureTopic } from '../analytics/kafka.js';
import { config } from '../config.js';
import { ensureClickPartitions } from '../db/partitions.js';
import { createPool } from '../db/pool.js';
import { kafkaConsumerLag } from '../observability/metrics.js';
import { startMetricsServer } from '../observability/metricsServer.js';
import { ClickWriter, processClickMessages } from './clickWriter.js';
import { createWorkerLogger, onShutdownSignal } from './runtime.js';

const PARTITION_MAINTENANCE_MS = 60 * 60 * 1000;
const LAG_POLL_MS = 15_000;

async function updateConsumerLag(admin: Admin, groupId: string, topic: string): Promise<void> {
  const [latest, committed] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);

  const committedByPartition = new Map<number, number>();
  for (const partition of committed[0]?.partitions ?? []) {
    committedByPartition.set(partition.partition, Number(partition.offset));
  }

  for (const partition of latest) {
    const high = Number(partition.high);
    const done = committedByPartition.get(partition.partition) ?? -1;
    const lag = done < 0 ? high - Number(partition.low) : high - done;
    kafkaConsumerLag.set({ topic, partition: String(partition.partition) }, Math.max(0, lag));
  }
}

async function main(): Promise<void> {
  const logger = createWorkerLogger('click-consumer');
  const { kafka: kafkaConfig } = config;

  const db = createPool(config.databaseUrl, (error) => logger.error({ err: error }, 'postgres pool error'));
  const kafka = createKafka(kafkaConfig, logger);
  const writer = new ClickWriter(db);
  let running = false;

  await ensureTopic(kafka, kafkaConfig.clickTopic, kafkaConfig.clickTopicPartitions);
  await ensureClickPartitions(db, { logger });
  const partitionTimer = setInterval(() => {
    void ensureClickPartitions(db, { logger });
  }, PARTITION_MAINTENANCE_MS);

  const consumer = kafka.consumer({ groupId: kafkaConfig.consumerGroup });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    running = false;
    logger.error({ err: payload.error, restart: payload.restart }, 'consumer crashed');
  });
  consumer.on(consumer.events.GROUP_JOIN, () => {
    running = true;
  });

  await consumer.connect();
  await consumer.subscribe({ topic: kafkaConfig.clickTopic, fromBeginning: true });
  await consumer.run({
    partitionsConsumedConcurrently: 3,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      // Throwing here (e.g. Postgres down) makes kafkajs retry the batch: at-least-once,
      // and the writer's ON CONFLICT DO NOTHING turns that into exactly-once rows.
      const { written, invalid } = await processClickMessages(batch.messages, writer);
      const last = batch.messages.at(-1);
      if (last) {
        resolveOffset(last.offset);
      }
      await heartbeat();
      logger.debug({ partition: batch.partition, written, invalid }, 'processed click batch');
    },
  });

  const admin = kafka.admin();
  await admin.connect();
  const lagTimer = setInterval(() => {
    updateConsumerLag(admin, kafkaConfig.consumerGroup, kafkaConfig.clickTopic).catch((error: unknown) =>
      logger.warn({ err: error }, 'could not fetch consumer lag'),
    );
  }, LAG_POLL_MS);

  const metricsServer = startMetricsServer(config.worker.metricsPort, () => running, (port) =>
    logger.info({ port }, 'worker metrics listening'),
  );

  logger.info({ topic: kafkaConfig.clickTopic, group: kafkaConfig.consumerGroup }, 'click consumer started');

  onShutdownSignal(async () => {
    clearInterval(partitionTimer);
    clearInterval(lagTimer);
    await consumer.disconnect();
    await admin.disconnect();
    await db.end();
    metricsServer.close();
  }, logger);
}

main().catch((error: unknown) => {
  console.error('click consumer failed to start:', error);
  process.exit(1);
});
