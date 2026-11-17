import type { Queryable } from './pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function clickPartitionName(day: Date): string {
  return `clicks_p${isoDay(day).replace(/-/g, '')}`;
}

export interface PartitionSpec {
  name: string;
  from: string;
  to: string;
}

/** Daily partitions covering [today - daysBack, today + daysAhead], in UTC. */
export function plannedClickPartitions(now: Date, daysBack = 1, daysAhead = 7): PartitionSpec[] {
  const today = startOfUtcDay(now).getTime();
  const specs: PartitionSpec[] = [];

  for (let offset = -daysBack; offset <= daysAhead; offset += 1) {
    const day = new Date(today + offset * DAY_MS);
    const next = new Date(day.getTime() + DAY_MS);
    specs.push({
      name: clickPartitionName(day),
      from: `${isoDay(day)} 00:00:00+00`,
      to: `${isoDay(next)} 00:00:00+00`,
    });
  }

  return specs;
}

export interface PartitionLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Idempotently creates upcoming daily partitions. Creating one fails if the DEFAULT
 * partition already holds rows for that day; that is logged and skipped, not fatal.
 */
export async function ensureClickPartitions(
  db: Queryable,
  options: { now?: Date; daysBack?: number; daysAhead?: number; logger?: PartitionLogger } = {},
): Promise<void> {
  const { now = new Date(), daysBack, daysAhead, logger = console } = options;

  for (const spec of plannedClickPartitions(now, daysBack, daysAhead)) {
    try {
      // Names and bounds are generated from dates above, never from user input.
      await db.query(
        `CREATE TABLE IF NOT EXISTS ${spec.name} PARTITION OF clicks
         FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
      );
    } catch (error) {
      logger.warn({ err: error, partition: spec.name }, 'could not create click partition');
    }
  }
}
