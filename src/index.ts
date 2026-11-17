import { pino } from 'pino';
import { buildApp } from './app.js';
import { config } from './config.js';
import { createContainer } from './container.js';
import { loggerOptions } from './observability/logger.js';

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const logger = pino(loggerOptions(config));
  const lifecycle = { shuttingDown: false };

  const container = await createContainer(config, logger);
  const app = await buildApp({ config, lifecycle, logger, ...container.deps });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');

    // Fail readiness first so the load balancer stops routing here, then drain.
    lifecycle.shuttingDown = true;
    if (config.nodeEnv === 'production') {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    }

    try {
      await app.close();
      await container.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
