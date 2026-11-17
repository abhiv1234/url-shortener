import { afterEach, describe, expect, it } from 'vitest';
import { buildClickEvent } from '../src/analytics/clickEvent.js';
import { BufferedClickPublisher, type ClickProducer } from '../src/analytics/clickPublisher.js';
import { clickEventsDroppedTotal } from '../src/observability/metrics.js';

const silent = { info: () => undefined, warn: () => undefined };

function event(urlId = '1') {
  return buildClickEvent({ urlId, ip: '10.0.0.1', referrer: undefined, salt: 's' });
}

function fakeProducer(overrides: Partial<ClickProducer> = {}) {
  const sent: { topic: string; messages: { key: string; value: string }[] }[] = [];
  const producer: ClickProducer = {
    connect: async () => undefined,
    send: async (record) => {
      sent.push(record);
    },
    disconnect: async () => undefined,
    ...overrides,
  };
  return { producer, sent };
}

async function droppedCount(reason: string): Promise<number> {
  const metric = await clickEventsDroppedTotal.get();
  return metric.values.find((value) => value.labels.reason === reason)?.value ?? 0;
}

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('BufferedClickPublisher', () => {
  let publisher: BufferedClickPublisher | undefined;
  afterEach(async () => {
    await publisher?.close();
  });

  it('batches buffered events into Kafka messages keyed by url id', async () => {
    const { producer, sent } = fakeProducer();
    publisher = new BufferedClickPublisher(producer, { topic: 'click-events', flushIntervalMs: 10_000, logger: silent });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    publisher.publish(event('7'));
    publisher.publish(event('8'));
    await publisher.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe('click-events');
    expect(sent[0].messages.map((m) => m.key)).toEqual(['7', '8']);
    expect(JSON.parse(sent[0].messages[0].value).urlId).toBe('7');
    expect(publisher.bufferedCount()).toBe(0);
  });

  it('flushes as soon as a full batch is buffered', async () => {
    const { producer, sent } = fakeProducer();
    publisher = new BufferedClickPublisher(producer, { topic: 't', batchSize: 3, flushIntervalMs: 10_000, logger: silent });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    for (let i = 0; i < 3; i += 1) publisher.publish(event());
    await waitFor(() => sent.length > 0);

    expect(sent[0].messages).toHaveLength(3);
  });

  it('keeps buffering while Kafka is unreachable, then drops beyond the bound', async () => {
    const { producer } = fakeProducer({
      connect: async () => {
        throw new Error('broker down');
      },
    });
    publisher = new BufferedClickPublisher(producer, {
      topic: 't',
      maxBufferSize: 2,
      reconnectDelayMs: 60_000,
      logger: silent,
    });
    await publisher.start();

    const before = await droppedCount('buffer_full');
    publisher.publish(event());
    publisher.publish(event());
    publisher.publish(event());

    expect(publisher.isConnected()).toBe(false);
    expect(publisher.bufferedCount()).toBe(2);
    expect(await droppedCount('buffer_full')).toBe(before + 1);
  });

  it('re-buffers a failed batch, reports unhealthy, and delivers it once Kafka recovers', async () => {
    let failing = true;
    const sent: string[][] = [];
    const { producer } = fakeProducer({
      send: async (record) => {
        if (failing) throw new Error('broker down');
        sent.push(record.messages.map((m) => m.key));
      },
    });
    publisher = new BufferedClickPublisher(producer, {
      topic: 't',
      flushIntervalMs: 10_000,
      retryBaseDelayMs: 20,
      logger: silent,
    });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    const before = await droppedCount('send_failed');
    publisher.publish(event('1'));
    publisher.publish(event('2'));
    await expect(publisher.flush()).resolves.toBeUndefined();

    expect(publisher.bufferedCount()).toBe(2);
    expect(publisher.isConnected()).toBe(false);
    expect(await droppedCount('send_failed')).toBe(before);

    // Still inside the backoff window: no retry yet.
    publisher.publish(event('3'));
    await publisher.flush();
    expect(sent).toHaveLength(0);

    failing = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await publisher.flush();

    expect(sent).toEqual([['1', '2', '3']]);
    expect(publisher.bufferedCount()).toBe(0);
    expect(publisher.isConnected()).toBe(true);
  });

  it('drops only what no longer fits when a failed batch is re-buffered', async () => {
    let release!: () => void;
    const { producer } = fakeProducer({
      send: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('timeout'));
        }),
    });
    publisher = new BufferedClickPublisher(producer, {
      topic: 't',
      maxBufferSize: 3,
      batchSize: 2,
      flushIntervalMs: 10_000,
      logger: silent,
    });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    publisher.publish(event('1'));
    publisher.publish(event('2')); // full batch → send in flight (2 events out of the buffer)
    await waitFor(() => release !== undefined);
    publisher.publish(event('3'));
    publisher.publish(event('4'));

    const before = await droppedCount('buffer_full');
    release();
    await publisher.flush();

    expect(publisher.bufferedCount()).toBe(3);
    expect(await droppedCount('buffer_full')).toBe(before + 1);
  });

  it('does not hang shutdown when Kafka never answers', async () => {
    const { producer } = fakeProducer({ send: () => new Promise(() => undefined), disconnect: () => new Promise(() => undefined) });
    publisher = new BufferedClickPublisher(producer, { topic: 't', flushIntervalMs: 10_000, closeTimeoutMs: 30, logger: silent });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    publisher.publish(event());
    const before = await droppedCount('shutdown');
    const started = Date.now();
    await publisher.close();

    expect(Date.now() - started).toBeLessThan(500);
    expect(await droppedCount('shutdown')).toBe(before + 1);
    publisher = undefined;
  });

  it('flushes what is left on close and rejects events afterwards', async () => {
    const { producer, sent } = fakeProducer();
    publisher = new BufferedClickPublisher(producer, { topic: 't', flushIntervalMs: 10_000, logger: silent });
    await publisher.start();
    await waitFor(() => publisher!.isConnected());

    publisher.publish(event());
    await publisher.close();
    expect(sent).toHaveLength(1);

    const before = await droppedCount('closed');
    publisher.publish(event());
    expect(await droppedCount('closed')).toBe(before + 1);
    publisher = undefined;
  });
});
