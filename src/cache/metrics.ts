import { staleCacheServedTotal } from '../observability/metrics.js';

/** Thin wrapper kept for the cache layer; backed by the Prometheus counter. */
let staleCacheServedCount = 0;

export function incrementStaleCacheServed(): void {
  staleCacheServedCount += 1;
  staleCacheServedTotal.inc();
}

export function getStaleCacheServedCount(): number {
  return staleCacheServedCount;
}

export function resetMetrics(): void {
  staleCacheServedCount = 0;
}
