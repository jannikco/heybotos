// Runs the service's tests on the desktop app's own runtime (Electron acting as Node), which is what
// people who install the app get, instead of on the Node the code is developed with.
//
//   node scripts/test-on-runtime.mjs
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { desktop, repo } from './payload.mjs'

// In a workflow each test is named as it ends, so one that never ends can be told from the rest.
const electron = createRequire(join(desktop, 'package.json'))('electron')
const res = spawnSync(electron, [join('node_modules', 'vitest', 'vitest.mjs'), 'run', ...(process.env.CI ? ['--reporter=verbose'] : [])], { cwd: join(repo, 'apps', 'daemon'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' })
process.exit(res.status ?? 1)
