import type pg from 'pg';
import type { UrlService } from './urlService.js';

export interface UrlStats {
  urlId: string;
  totalClicks: number;
  clicksByDay: { date: string; count: number }[];
  topReferrers: { referrer: string; count: number }[];
}

export interface StatsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export const STATS_DAYS = 30;
export const TOP_REFERRERS = 10;

export class StatsService {
  constructor(
    private readonly db: Pick<pg.Pool, 'query'>,
    private readonly urls: Pick<UrlService, 'assertOwner'>,
    private readonly cache?: StatsCache,
    private readonly cacheTtlSeconds = 30,
  ) {}

  async getStats(id: string, userId: string): Promise<UrlStats> {
    const { id: urlId } = await this.urls.assertOwner(id, userId);
    const key = `stats:${urlId}`;

    const cached = await this.cache?.get(key).catch(() => null);
    if (cached) {
      return JSON.parse(cached) as UrlStats;
    }

    const [total, byDay, referrers] = await Promise.all([
      this.db.query<{ count: string }>('SELECT count(*) AS count FROM clicks WHERE url_id = $1', [
        urlId,
      ]),
      // Zero-filled, one row per UTC day for the last 30 days (today included).
      this.db.query<{ date: string; count: number }>(
        `WITH days AS (
           SELECT generate_series(
             (now() AT TIME ZONE 'UTC')::date - ($2::int - 1),
             (now() AT TIME ZONE 'UTC')::date,
             interval '1 day'
           )::date AS day
         ),
         counts AS (
           SELECT (ts AT TIME ZONE 'UTC')::date AS day, count(*) AS count
           FROM clicks
           WHERE url_id = $1
             AND ts >= ((now() AT TIME ZONE 'UTC')::date - ($2::int - 1))::timestamp AT TIME ZONE 'UTC'
           GROUP BY 1
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS date, COALESCE(counts.count, 0)::int AS count
         FROM days LEFT JOIN counts USING (day)
         ORDER BY days.day`,
        [urlId, STATS_DAYS],
      ),
      this.db.query<{ referrer: string; count: number }>(
        `SELECT referrer, count(*)::int AS count
         FROM clicks
         WHERE url_id = $1 AND referrer IS NOT NULL
         GROUP BY referrer
         ORDER BY count DESC, referrer
         LIMIT $2`,
        [urlId, TOP_REFERRERS],
      ),
    ]);

    const stats: UrlStats = {
      urlId,
      totalClicks: Number(total.rows[0]?.count ?? 0),
      clicksByDay: byDay.rows.map((row) => ({ date: row.date, count: Number(row.count) })),
      topReferrers: referrers.rows.map((row) => ({ referrer: row.referrer, count: Number(row.count) })),
    };

    await this.cache?.set(key, JSON.stringify(stats), 'EX', this.cacheTtlSeconds).catch(() => undefined);
    return stats;
  }
}
