import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
