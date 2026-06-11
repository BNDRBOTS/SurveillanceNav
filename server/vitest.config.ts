import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false, // tests share one Postgres database
    globalSetup: './test/globalSetup.ts',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://stn:stn_dev_password@localhost:5432/stn_test',
      REDIS_URL: '', // tests exercise the in-memory cache fallback path
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test',
      REFRESH_SECRET: 'test-refresh-secret-test-refresh-sec',
      DOWNLOAD_SECRET: 'test-download-secret-test-download-s',
      STORAGE_LOCAL_DIR: path.join('/tmp', 'stn-test-storage'),
      MAIL_OUTBOX_DIR: path.join('/tmp', 'stn-test-mail'),
      JOBS_ENABLED: 'false',
      AUTO_MIGRATE: 'false',
    },
  },
  resolve: {
    alias: {
      '@stn/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
