import Fastify from 'fastify';
import { connectRedis } from './cache/redis.js';
import { Singleflight } from './cache/singleflight.js';
import { UrlCache } from './cache/urlCache.js';
import { config } from './config.js';
import { redirectRoutes } from './routes/redirect.js';
import { urlRoutes } from './routes/urls.js';
import { UrlService } from './services/urlService.js';

export async function buildApp() {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
  });

  const redis = await connectRedis();
  const cache = new UrlCache(redis);
  const singleflight = new Singleflight(redis);
  const urlService = new UrlService(undefined, config.shortUrlBase, cache, singleflight);

  app.get('/health', async () => ({ status: 'ok' }));

  await urlRoutes(app, urlService);
  await redirectRoutes(app, urlService);

  return app;
}
