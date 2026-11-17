import type { LoggerOptions } from 'pino';
import type { AppConfig } from '../config.js';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  'token',
  '*.token',
];

export function loggerOptions(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): LoggerOptions {
  const options: LoggerOptions = {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };

  if (config.nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }

  return options;
}
