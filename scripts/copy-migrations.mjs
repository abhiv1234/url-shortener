// tsc only emits .js; the migration runner reads .sql files next to it.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
