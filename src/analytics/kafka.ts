import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import type { AppConfig } from '../config.js';

export interface KafkaLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

const NOISY_NAMESPACES = new Set(['Connection', 'BrokerPool']);

export function createKafka(kafkaConfig: AppConfig['kafka'], logger: KafkaLogger): Kafka {
  return new Kafka({
    clientId: kafkaConfig.clientId,
    brokers: kafkaConfig.brokers,
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
    retry: { retries: 5, initialRetryTime: 300 },
    logLevel: logLevel.WARN,
    logCreator: () => (entry) => {
      const { message, ...extra } = entry.log;
      const fields = { namespace: entry.namespace, ...extra };
      // While a broker is down kafkajs logs an ERROR per retry; callers already log one
      // summarised warning per connect attempt, so keep these at debug to avoid log floods.
      const level = NOISY_NAMESPACES.has(entry.namespace) ? logLevel.DEBUG : entry.level;
      switch (level) {
        case logLevel.ERROR:
          logger.error(fields, `kafka: ${message}`);
          break;
        case logLevel.WARN:
          logger.warn(fields, `kafka: ${message}`);
          break;
        case logLevel.INFO:
          logger.info(fields, `kafka: ${message}`);
          break;
        default:
          logger.debug(fields, `kafka: ${message}`);
      }
    },
  });
}

/** Idempotent: creates the topic with the configured partition count if it is missing. */
export async function ensureTopic(kafka: Kafka, topic: string, numPartitions: number): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    if (!existing.includes(topic)) {
      await admin.createTopics({
        topics: [{ topic, numPartitions, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    }
  } finally {
    await admin.disconnect();
  }
}

export function createClickProducer(kafka: Kafka): Producer {
  return kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    allowAutoTopicCreation: false,
    retry: { retries: 3 },
  });
}
