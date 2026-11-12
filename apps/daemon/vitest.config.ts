import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Tests start real (fake) worker processes; keep files apart so they do not fight over slots.
    fileParallelism: false,
  },
})
