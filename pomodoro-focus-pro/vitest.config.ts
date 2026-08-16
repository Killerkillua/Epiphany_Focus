import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    // 演示模式 mockReply 按 16ms 词块推流，放宽超时
    testTimeout: 15000,
    hookTimeout: 15000
  }
})
