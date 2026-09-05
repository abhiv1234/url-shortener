/** Metric stubs — wired to real instrumentation in Phase 5. */

let staleCacheServedCount = 0;

export function incrementStaleCacheServed(): void {
  staleCacheServedCount += 1;
}

export function getStaleCacheServedCount(): number {
  return staleCacheServedCount;
}

export function resetMetrics(): void {
  staleCacheServedCount = 0;
}
