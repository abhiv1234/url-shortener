import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * One registry per process. The API and the worker each expose their own `/metrics`;
 * metrics that only one of them updates simply stay at zero in the other.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route and status class',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route and status class (2xx/3xx/4xx/5xx)',
  labelNames: ['method', 'route', 'status_class'] as const,
  registers: [registry],
});

export const redirectDuration = new Histogram({
  name: 'redirect_duration_seconds',
  help: 'Time to resolve a short code and send the redirect',
  labelNames: ['outcome'] as const,
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const cacheRequestsTotal = new Counter({
  name: 'cache_requests_total',
  help: 'Redirect cache lookups by result (hit, miss, error)',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const staleCacheServedTotal = new Counter({
  name: 'stale_cache_served_total',
  help: 'Redirects served from cache because Postgres was unavailable',
  registers: [registry],
});

export const urlsCreatedTotal = new Counter({
  name: 'urls_created_total',
  help: 'Short URLs created, by code type',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const clickEventsPublishedTotal = new Counter({
  name: 'click_events_published_total',
  help: 'Click events acknowledged by Kafka',
  registers: [registry],
});

export const clickEventsDroppedTotal = new Counter({
  name: 'click_events_dropped_total',
  help: 'Click events dropped before reaching Kafka, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const clickPublishErrorsTotal = new Counter({
  name: 'click_publish_errors_total',
  help: 'Failed sends to Kafka (the batch is re-buffered and retried with backoff)',
  registers: [registry],
});

export const clickPublisherBufferSize = new Gauge({
  name: 'click_publisher_buffer_size',
  help: 'Click events waiting in the in-process buffer',
  registers: [registry],
});

export const clicksWrittenTotal = new Counter({
  name: 'clicks_written_total',
  help: 'Click rows inserted by the worker (duplicates excluded)',
  registers: [registry],
});

export const clickEventsInvalidTotal = new Counter({
  name: 'click_events_invalid_total',
  help: 'Kafka messages the worker could not parse and skipped',
  registers: [registry],
});

export const kafkaConsumerLag = new Gauge({
  name: 'kafka_consumer_lag',
  help: 'Messages between the latest offset and the committed offset, per partition',
  labelNames: ['topic', 'partition'] as const,
  registers: [registry],
});

export const expiredUrlsPurgedTotal = new Counter({
  name: 'expired_urls_purged_total',
  help: 'Expired URLs deleted by the cleanup job',
  registers: [registry],
});

export function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}
