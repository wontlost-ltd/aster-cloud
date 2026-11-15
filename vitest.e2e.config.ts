// E2E 测试专用配置：跑 src/__tests__/e2e/** 与 src/__tests__/e2e-agent-guard/**
// 默认 vitest run 不会包含这些目录（见 vitest.config.ts exclude）
//
// 运行：pnpm test:e2e
// 前提：dev server 在 http://localhost:3001（或设 E2E_BASE_URL）
// e2e-agent-guard 另需 AGENT_GUARD_DEMO_E2E=1 与 aster-api（docs/runbooks/agent-guard-demo.md），否则 skip
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/__tests__/e2e/**/*.{test,spec}.{ts,tsx,js}',
      'src/__tests__/e2e-agent-guard/**/*.{test,spec}.{ts,tsx,js}',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
