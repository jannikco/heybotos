import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

// Browser tests run against the real daemon in demo mode: fake CLI, throwaway data folder, own port.
// The demo script empties the folder when it starts (HEYBOTOS_DEMO_FRESH); nothing here touches it,
// because this file is loaded by several processes during a run.
export const E2E_HOME = join(import.meta.dirname, 'e2e', '.home')
export const E2E_PORT = 4749

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, channel: 'chrome', viewport: { width: 1360, height: 860 } },
  webServer: {
    command: 'node apps/daemon/scripts/demo.ts',
    url: `http://127.0.0.1:${E2E_PORT}/`,
    env: { HEYBOTOS_HOME: E2E_HOME, HEYBOTOS_DEMO_FRESH: '1', HEYBOTOS_DEMO_PORT: String(E2E_PORT), HEYBOTOS_DEMO_DELAY: '40' },
    reuseExistingServer: false,
  },
})
