import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // .public-build 是发布用的脱敏副本（自带一套测试），别在本仓库重复跑
    exclude: ['node_modules', 'dist', '.wrangler', '.public-build'],
  },
});
