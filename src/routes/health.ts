import type { FastifyInstance } from 'fastify';
import { registry } from '../observability/metrics.js';

export interface HealthChecks {
  database(): Promise<void>;
  redis(): Promise<void>;
  kafkaConnected(): boolean;
}

export interface Lifecycle {
  shuttingDown: boolean;
}

const CHECK_TIMEOUT_MS = 1_000;

async function probe(check: () => Promise<void>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export async function healthRoutes(
  app: FastifyInstance,
  deps: { checks: HealthChecks; lifecycle: Lifecycle },
): Promise<void> {
  const quiet = { logLevel: 'warn' as const };

  /** Deep health: 200 only when both Postgres and Redis are reachable. Kafka is informational. */
  app.get('/health', { ...quiet, schema: { tags: ['ops'], summary: 'Dependency health' } }, async (_request, reply) => {
    const [database, redis] = await Promise.all([probe(deps.checks.database), probe(deps.checks.redis)]);
    const healthy = database === 'up' && redis === 'up';
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      checks: { database, redis, kafka: deps.checks.kafkaConnected() ? 'up' : 'down' },
    });
  });

  /**
   * Readiness: keep receiving traffic while redirects can still be served — Postgres OR
   * Redis (stale cache) is enough. Fails immediately once shutdown starts so the load
   * balancer drains this instance.
   */
  app.get('/ready', { ...quiet, schema: { tags: ['ops'], summary: 'Readiness probe' } }, async (_request, reply) => {
    if (deps.lifecycle.shuttingDown) {
      return reply.status(503).send({ status: 'shutting_down' });
    }
    const [database, redis] = await Promise.all([probe(deps.checks.database), probe(deps.checks.redis)]);
    const ready = database === 'up' || redis === 'up';
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable', checks: { database, redis } });
  });

  app.get('/metrics', { ...quiet, schema: { tags: ['ops'], summary: 'Prometheus metrics', hide: false } }, async (_request, reply) => {
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
}
