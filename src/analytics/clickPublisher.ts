import {
  clickEventsDroppedTotal,
  clickEventsPublishedTotal,
  clickPublishErrorsTotal,
  clickPublisherBufferSize,
} from '../observability/metrics.js';
import { type ClickEvent, serializeClickEvent } from './clickEvent.js';

export interface ClickPublisher {
  /** Fire-and-forget. Never throws and never blocks the redirect. */
  publish(event: ClickEvent): void;
  start(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export class NoopClickPublisher implements ClickPublisher {
  publish(): void {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  isConnected(): boolean {
    return false;
  }
}

/** The slice of a kafkajs Producer this publisher needs (keeps it testable). */
export interface ClickProducer {
  connect(): Promise<void>;
  send(record: { topic: string; messages: { key: string; value: string }[] }): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface PublisherLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface BufferedClickPublisherOptions {
  topic: string;
  maxBufferSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  reconnectDelayMs?: number;
  /** First retry delay after a failed send; doubles per consecutive failure. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Upper bound on how long close() may spend flushing (a dead broker must not hang shutdown). */
  closeTimeoutMs?: number;
  /** Runs before each connect attempt, e.g. to make sure the topic exists. */
  prepare?: () => Promise<void>;
  logger?: PublisherLogger;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Buffers click events in memory and ships them to Kafka in batches.
 *
 * Backpressure: the buffer is bounded. While Kafka is slow or down, events queue up to
 * `maxBufferSize` (a failed batch goes back to the front of the queue and is retried with
 * exponential backoff); beyond that bound new events are dropped and counted, so redirects
 * never wait on Kafka and memory never grows without bound. A retried batch may reach Kafka
 * twice if only the ack was lost — the worker dedupes on `eventId`.
 */
export class BufferedClickPublisher implements ClickPublisher {
  private readonly topic: string;
  private readonly maxBufferSize: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly closeTimeoutMs: number;
  private readonly prepare?: () => Promise<void>;
  private readonly logger: PublisherLogger;

  private buffer: ClickEvent[] = [];
  private connected = false;
  private healthy = false;
  private closed = false;
  private consecutiveFailures = 0;
  private inFlight = 0;
  private retryAt = 0;
  private flushing: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private lastFailureLogAt = 0;

  constructor(
    private readonly producer: ClickProducer,
    options: BufferedClickPublisherOptions,
  ) {
    this.topic = options.topic;
    this.maxBufferSize = options.maxBufferSize ?? 10_000;
    this.batchSize = options.batchSize ?? 500;
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3_000;
    this.prepare = options.prepare;
    this.logger = options.logger ?? console;
  }

  publish(event: ClickEvent): void {
    if (this.closed) {
      clickEventsDroppedTotal.inc({ reason: 'closed' });
      return;
    }

    if (this.buffer.length >= this.maxBufferSize) {
      clickEventsDroppedTotal.inc({ reason: 'buffer_full' });
      return;
    }

    this.buffer.push(event);
    clickPublisherBufferSize.set(this.buffer.length);

    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  async start(): Promise<void> {
    this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.flushTimer.unref();
    void this.connect();
  }

  /** True only while the last interaction with Kafka succeeded (drives /health). */
  isConnected(): boolean {
    return this.connected && this.healthy;
  }

  bufferedCount(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    if (!this.connected || this.buffer.length === 0 || Date.now() < this.retryAt) {
      return;
    }
    return this.startDrain();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.flushTimer);
    clearTimeout(this.reconnectTimer);

    if (this.connected) {
      // Ignore any retry backoff for one last bounded attempt.
      this.retryAt = 0;
      await withTimeout(this.flushing ?? this.startDrain(), this.closeTimeoutMs);
    }

    // Events still in an unfinished send are counted as lost too (they may or may not land).
    const lost = this.buffer.length + (this.flushing ? this.inFlight : 0);
    if (lost > 0) {
      clickEventsDroppedTotal.inc({ reason: 'shutdown' }, lost);
      this.buffer = [];
      clickPublisherBufferSize.set(0);
    }

    if (this.connected) {
      this.connected = false;
      await withTimeout(this.producer.disconnect().catch(() => undefined), this.closeTimeoutMs);
    }
  }

  private startDrain(): Promise<void> {
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async connect(): Promise<void> {
    try {
      await this.prepare?.();
      await this.producer.connect();
      if (this.closed) {
        await this.producer.disconnect().catch(() => undefined);
        return;
      }
      this.connected = true;
      this.healthy = true;
      this.logger.info({ topic: this.topic }, 'click publisher connected to Kafka');
    } catch (error) {
      this.logger.warn(
        { err: error, retryInMs: this.reconnectDelayMs },
        'click publisher could not connect to Kafka; buffering events',
      );
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectDelayMs);
        this.reconnectTimer.unref();
      }
    }
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0 && this.connected) {
      const batch = this.buffer.splice(0, this.batchSize);
      clickPublisherBufferSize.set(this.buffer.length);

      this.inFlight = batch.length;
      try {
        await this.producer.send({
          topic: this.topic,
          // Keyed by url id: one URL's clicks stay ordered on one partition, and
          // traffic spreads across partitions instead of hot-spotting on one key.
          messages: batch.map((event) => ({ key: event.urlId, value: serializeClickEvent(event) })),
        });
        clickEventsPublishedTotal.inc(batch.length);
        if (!this.healthy) {
          this.logger.info({ topic: this.topic }, 'click publisher recovered; Kafka is accepting events');
        }
        this.healthy = true;
        this.consecutiveFailures = 0;
        this.retryAt = 0;
      } catch (error) {
        this.requeue(batch);
        this.healthy = false;
        this.consecutiveFailures += 1;
        const delay = Math.min(
          this.retryMaxDelayMs,
          this.retryBaseDelayMs * 2 ** (this.consecutiveFailures - 1),
        );
        this.retryAt = Date.now() + delay;
        clickPublishErrorsTotal.inc();
        this.logFailure(error, delay);
        return;
      } finally {
        this.inFlight = 0;
      }
    }
  }

  /** Puts a failed batch back at the front; anything beyond the bound is dropped (newest first). */
  private requeue(batch: ClickEvent[]): void {
    this.buffer = batch.concat(this.buffer);
    const overflow = this.buffer.length - this.maxBufferSize;
    if (overflow > 0) {
      this.buffer.length = this.maxBufferSize;
      clickEventsDroppedTotal.inc({ reason: 'buffer_full' }, overflow);
    }
    clickPublisherBufferSize.set(this.buffer.length);
  }

  private logFailure(error: unknown, retryInMs: number): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt > 10_000) {
      this.lastFailureLogAt = now;
      this.logger.warn(
        { err: error, buffered: this.buffer.length, retryInMs },
        'failed to publish click events; will retry',
      );
    }
  }
}
