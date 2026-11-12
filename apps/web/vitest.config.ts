import { defineConfig } from 'vitest/config'

// Plain unit tests of the dashboard's pure code; nothing here needs a browser.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
