import type { FastifyInstance } from 'fastify';
import type { ClickEvent } from '../../src/analytics/clickEvent.js';
import type { ClickPublisher } from '../../src/analytics/clickPublisher.js';
import { buildApp } from '../../src/app.js';
import { TokenService } from '../../src/auth/tokens.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import { ForbiddenError, GoneError, NotFoundError } from '../../src/errors.js';
import type { AuthService } from '../../src/services/authService.js';
import type { StatsService } from '../../src/services/statsService.js';
import type { CreateUrlInput, UrlService } from '../../src/services/urlService.js';

export const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const STRANGER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

export class RecordingPublisher implements ClickPublisher {
  events: ClickEvent[] = [];
  publish(event: ClickEvent): void {
    this.events.push(event);
  }
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
}

/** In-memory stand-ins for the services; the HTTP layer under test is real. */
export function fakeUrlService() {
  const created: { input: CreateUrlInput; userId: string | null }[] = [];
  const service = {
    created,
    async createUrl(input: CreateUrlInput, userId: string | null) {
      created.push({ input, userId });
      return {
        id: '125',
        shortCode: input.customAlias ?? '21',
        shortUrl: `http://localhost:3000/${input.customAlias ?? '21'}`,
        longUrl: input.longUrl,
        expiresAt: null,
        createdAt: '2026-11-17T00:00:00.000Z',
      };
    },
    async resolve(code: string) {
      if (code === 'expired') throw new GoneError('link has expired', 'GONE');
      if (code === 'abc') return { id: '7', longUrl: 'https://example.com/target', expiresAt: null };
      throw new NotFoundError('short code not found', 'NOT_FOUND');
    },
    async deleteUrl(id: string, userId: string) {
      if (id !== '7') throw new NotFoundError('url not found', 'NOT_FOUND');
      if (userId !== OWNER) throw new ForbiddenError('you do not own this url', 'FORBIDDEN');
    },
    async listUrls() {
      return { items: [], nextCursor: null };
    },
  };
  return service;
}

export interface TestAppOptions {
  config?: Partial<AppConfig>;
  healthy?: { database: boolean; redis: boolean };
  lifecycle?: { shuttingDown: boolean };
}

export async function createTestApp(options: TestAppOptions = {}) {
  const config: AppConfig = {
    ...loadConfig({ NODE_ENV: 'test' }),
    ...options.config,
  };
  const tokens = new TokenService('test-secret', 3600);
  const urlService = fakeUrlService();
  const publisher = new RecordingPublisher();
  const healthy = options.healthy ?? { database: true, redis: true };

  const statsService = {
    async getStats(id: string, userId: string) {
      if (userId !== OWNER) throw new ForbiddenError('you do not own this url', 'FORBIDDEN');
      return { urlId: id, totalClicks: 2, clicksByDay: [], topReferrers: [] };
    },
  };

  const authService = {
    async register(body: { email: string }) {
      return { id: OWNER, email: body.email, createdAt: '2026-11-17T00:00:00.000Z' };
    },
    async login() {
      return tokens.sign(OWNER);
    },
  };

  const app: FastifyInstance = await buildApp({
    config,
    tokens,
    urlService: urlService as unknown as UrlService,
    statsService: statsService as unknown as StatsService,
    authService: authService as unknown as AuthService,
    clickPublisher: publisher,
    lifecycle: options.lifecycle,
    healthChecks: {
      database: async () => {
        if (!healthy.database) throw new Error('db down');
      },
      redis: async () => {
        if (!healthy.redis) throw new Error('redis down');
      },
      kafkaConnected: () => true,
    },
  });

  const bearer = (userId: string) => ({ authorization: `Bearer ${tokens.sign(userId).token}` });
  return { app, urlService, publisher, bearer };
}
