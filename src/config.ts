import 'dotenv/config';

export interface RateLimitRule {
  max: number;
  timeWindowMs: number;
}

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  logLevel: string;
  shortUrlBase: string;
  databaseUrl: string;
  redisUrl: string;
  trustProxy: boolean;
  /** Cache-Control max-age for 302 responses. 0 → `no-store` so every click reaches us. */
  redirectCacheMaxAgeSeconds: number;
  kafka: {
    enabled: boolean;
    brokers: string[];
    clientId: string;
    clickTopic: string;
    clickTopicPartitions: number;
    consumerGroup: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresInSeconds: number;
    bcryptRounds: number;
  };
  ipHashSalt: string;
  rateLimit: {
    enabled: boolean;
    create: RateLimitRule;
    redirect: RateLimitRule;
    auth: RateLimitRule;
  };
  worker: {
    metricsPort: number;
    cleanupIntervalMs: number;
  };
}

const INSECURE_DEFAULT_SECRET = 'change-me-in-production';

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = str(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const jwtSecret = str(env, 'JWT_SECRET', INSECURE_DEFAULT_SECRET);
  const ipHashSalt = str(env, 'IP_HASH_SALT', INSECURE_DEFAULT_SECRET);

  if (isProduction) {
    for (const [name, value] of [
      ['JWT_SECRET', jwtSecret],
      ['IP_HASH_SALT', ipHashSalt],
    ] as const) {
      if (value === INSECURE_DEFAULT_SECRET || value.length < 32) {
        throw new Error(`${name} must be set to a random value of at least 32 characters in production`);
      }
    }
  }

  return {
    port: int(env, 'PORT', 3000),
    host: str(env, 'HOST', '0.0.0.0'),
    nodeEnv,
    logLevel: str(env, 'LOG_LEVEL', isTest ? 'silent' : 'info'),
    shortUrlBase: str(env, 'SHORT_URL_BASE', 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://urlshort:urlshort@localhost:5432/urlshort'),
    redisUrl: str(env, 'REDIS_URL', 'redis://localhost:6379'),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    redirectCacheMaxAgeSeconds: int(env, 'REDIRECT_CACHE_MAX_AGE_SECONDS', 0),
    kafka: {
      enabled: bool(env, 'KAFKA_ENABLED', true),
      brokers: str(env, 'KAFKA_BROKERS', 'localhost:9092')
        .split(',')
        .map((broker) => broker.trim())
        .filter(Boolean),
      clientId: str(env, 'KAFKA_CLIENT_ID', 'url-shortener'),
      clickTopic: str(env, 'KAFKA_CLICK_TOPIC', 'click-events'),
      clickTopicPartitions: int(env, 'KAFKA_CLICK_TOPIC_PARTITIONS', 6),
      consumerGroup: str(env, 'KAFKA_CONSUMER_GROUP', 'click-writer'),
    },
    auth: {
      jwtSecret,
      jwtExpiresInSeconds: int(env, 'JWT_EXPIRES_IN_SECONDS', 3600),
      bcryptRounds: int(env, 'BCRYPT_ROUNDS', isTest ? 4 : 12),
    },
    ipHashSalt,
    rateLimit: {
      enabled: bool(env, 'RATE_LIMIT_ENABLED', true),
      create: {
        max: int(env, 'RATE_LIMIT_CREATE_MAX', 100),
        timeWindowMs: int(env, 'RATE_LIMIT_CREATE_WINDOW_MS', 60 * 60 * 1000),
      },
      redirect: {
        max: int(env, 'RATE_LIMIT_REDIRECT_MAX', 1000),
        timeWindowMs: int(env, 'RATE_LIMIT_REDIRECT_WINDOW_MS', 60 * 1000),
      },
      auth: {
        max: int(env, 'RATE_LIMIT_AUTH_MAX', 20),
        timeWindowMs: int(env, 'RATE_LIMIT_AUTH_WINDOW_MS', 60 * 1000),
      },
    },
    worker: {
      metricsPort: int(env, 'WORKER_METRICS_PORT', 9101),
      cleanupIntervalMs: int(env, 'CLEANUP_INTERVAL_MS', 60 * 60 * 1000),
    },
  };
}

export const config: AppConfig = loadConfig();
