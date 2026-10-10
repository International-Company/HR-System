import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each file builds its own isolated database; keep files in separate workers.
    pool: 'forks',
    fileParallelism: process.env.TEST_DATABASE_URL ? false : true,
  },
});
