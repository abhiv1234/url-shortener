import { pino } from 'pino';
import { config } from '../config.js';
import { loggerOptions } from '../observability/logger.js';

export function createWorkerLogger(name: string) {
  return pino({ ...loggerOptions(config), name });
}

/** Runs `shutdown` once on SIGINT/SIGTERM, then exits. */
export function onShutdownSignal(shutdown: () => Promise<void>, logger: { info(msg: string): void; error(obj: unknown, msg?: string): void }): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`received ${signal}, shutting down`);
    shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
