// heybotosd: the HeyBotOS daemon. Run with `pnpm daemon`.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Bus } from './bus.ts'
import { Db } from './db.ts'
import { openHome } from './home.ts'
import { finishMove } from './migrate.ts'
import { Registry } from './registry.ts'
import { Tasks } from './tasks.ts'
import { Approvals, HUB } from './approvals.ts'
import { Manager } from './manager.ts'
import { Router } from './router.ts'
import { Routines } from './routines.ts'
import { ConnectorRegistry } from './connect/registry.ts'
import { Gateway } from './connect/gateway.ts'
import { Staff } from './staff.ts'
import { Settings } from './settings.ts'
import { Threads } from './threads.ts'
import { watchInbox } from './notify.ts'
import { loadGateConfig } from './policy/gate.ts'
import { claudeAdapter } from './engines/claude.ts'
import { codexAdapter } from './engines/codex.ts'
import { grokAdapter } from './engines/grok.ts'
import { Supervisor } from './engines/supervisor.ts'
import { Auth } from './http/auth.ts'
import { createApp } from './http/app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const { version, stage } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string; stage?: string }
// The Mac app carries a note of what it was built from; after an update that is how it tells an old service from a new one.
const build = existsSync(join(repo, 'BUILD')) ? readFileSync(join(repo, 'BUILD'), 'utf8').trim() : null

const home = openHome()
const db = new Db(home.dbPath)
finishMove(home.root, db)
const bus = new Bus()
const supervisor = new Supervisor(home, db, bus, { claude: claudeAdapter, codex: codexAdapter, grok: grokAdapter })
const registry = new Registry(home, db)
const tasks = new Tasks(home, db, bus, supervisor, registry)
const approvals = new Approvals(home, db, bus, supervisor, tasks, loadGateConfig(home))
const router = new Router(home, db, bus, supervisor, tasks)
const manager = new Manager(home, db, bus, supervisor, tasks, registry)
const routines = new Routines(db, manager)
const staff = new Staff(db, manager)
tasks.staff = staff
tasks.managerName = () => manager.name()
tasks.files.sweep()
setInterval(() => tasks.files.sweep(), 6 * 3600_000).unref()
const connectors = new ConnectorRegistry(home, db)
connectors.importOnce()
connectors.checkNew()
const gateway = new Gateway(home, db, connectors, approvals)
tasks.checkConnectors = (names) => connectors.check(names)
supervisor.hubFor = (run) => ({ name: HUB, url: gateway.urlFor(run.id, approvals.url) })
const settings = new Settings({ home, manager, approvals, router, registry, connectors, supervisor })
const presence = { desktop: 0 }
watchInbox(home, bus, undefined, presence)
const auth = new Auth(home, db, home.config.port)
const webRoot = join(repo, 'apps', 'web', 'dist')
const app = createApp({ home, bus, supervisor, registry, tasks, approvals, manager, router, routines, connectors, gateway, staff, settings, threads: new Threads(db, registry), presence, auth, version, stage, build, webRoot: existsSync(join(webRoot, 'index.html')) ? webRoot : undefined })

supervisor.start()
tasks.reconcile()
manager.start()
router.start()
routines.start()
void registry
  .scan()
  .then((n) => console.log(`  Projects      ${n} folders found in ${home.config.projectRoots.join(', ')}`))
  .catch((e) => console.error('[registry] scan failed:', e))

// Where no service manager knows this process, the terminal helper finds it by this number.
const pidFile = join(home.state, 'daemon.pid')
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: home.config.port }, () => {
  writeFileSync(pidFile, String(process.pid))
  console.log(`HeyBotOS ${version}${stage ? ` ${stage}` : ''} is running.`)
  console.log(`  Data folder   ${home.root}`)
  console.log(`  Workers       ${supervisor.activeCount()} picked up from before, up to ${home.config.maxWorkers} at a time`)
  console.log(`  Open it       ${auth.loginUrl()}`)
  console.log(`  (The link works once. "${process.versions.electron ? '' : 'pnpm '}heybotos open" gives a new one.)`)
})

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${home.config.port} is already in use. HeyBotOS may already be running; otherwise change "port" in ${join(home.configDir, 'heybotos.json')}.`)
    process.exit(1)
  }
  throw e
})

function stop(): void {
  // Workers keep running; the next start picks them up from their output files.
  manager.stop()
  router.stop()
  routines.stop()
  connectors.close()
  supervisor.shutdown()
  server.close()
  db.close()
  rmSync(pidFile, { force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
