import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // PTYや実サーバーを扱う統合テストは直列に実行する（ポート競合を避ける）。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
