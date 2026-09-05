import 'dotenv/config';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  shortUrlBase: string;
  databaseUrl: string;
  redisUrl: string;
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: AppConfig = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  shortUrlBase: requireEnv('SHORT_URL_BASE', 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: requireEnv(
    'DATABASE_URL',
    'postgres://urlshort:urlshort@localhost:5432/urlshort',
  ),
  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6379'),
};
