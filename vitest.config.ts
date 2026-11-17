import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoints are exercised by the integration suite and docker compose.
      exclude: ['src/index.ts', 'src/workers/clickConsumer.ts', 'src/workers/expiredUrlCleaner.ts', 'src/workers/runtime.ts', 'src/db/migrate.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
