import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bus } from '../src/bus.ts'
import { Db } from '../src/db.ts'
import { openHome, type Home } from '../src/home.ts'
import { Registry } from '../src/registry.ts'
import { Tasks } from '../src/tasks.ts'
import { Approvals, HUB } from '../src/approvals.ts'
import { Manager } from '../src/manager.ts'
import { Router } from '../src/router.ts'
import { Routines } from '../src/routines.ts'
import { ConnectorRegistry } from '../src/connect/registry.ts'
import { Gateway } from '../src/connect/gateway.ts'
import { Staff } from '../src/staff.ts'
import { Settings } from '../src/settings.ts'
import { Threads } from '../src/threads.ts'
import { loadGateConfig } from '../src/policy/gate.ts'
import { claudeAdapter } from '../src/engines/claude.ts'
import { codexAdapter } from '../src/engines/codex.ts'
import { grokAdapter } from '../src/engines/grok.ts'
import { Supervisor, type RunExtra } from '../src/engines/supervisor.ts'
import { GIT, WIN } from '../src/platform.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const FAKE = join(here, 'fakes', 'fake-cli.mjs')
export const FIXTURES = join(here, 'fixtures')
export const BASIC = join(FIXTURES, 'claude-basic.jsonl')

/** git in a folder, as text. */
export function git(dir: string, ...args: string[]): string {
  const out = execFileSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  // A new repository keeps files byte for byte, whatever this computer's git is set to do with line
  // endings (on Windows it usually rewrites them), so what a test writes is what it reads back.
  if (args[0] === 'init') execFileSync(GIT, ['-C', dir, 'config', 'core.autocrlf', 'false'])
  return out
}

/** Whether `path` (a PATH as a program got it) starts with `dir`. */
export const firstOnPath = (dir: string) => new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[;:]`, WIN ? 'i' : '')

/** A path the way a shell script wants it. On Windows the scripts run in Git's shell, which takes forward slashes. */
export const sh = (path: string) => (WIN ? path.replace(/\\/g, '/') : path)

/** What one of HeyBotOS's own scripts needs in its environment to be started by hand in a test. */
export function scriptEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH! }
  // Windows programs do not get far without knowing where the system is.
  if (WIN) for (const k of ['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'ComSpec', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k]!
  // When the tests themselves run on the desktop app's runtime, that program has to be told to act as Node.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** A stand-in for a program on PATH that only notes what it was called with, one call per line. */
export function standIn(dir: string, name: string, log: string): void {
  mkdirSync(dir, { recursive: true })
  if (WIN) writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho %*>> "${log}"\r\n`)
  else writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 })
}

/** Stop a process and everything it started, now. */
export function killTree(pid: number): void {
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}

export interface World {
  root: string
  home: Home
  db: Db
  bus: Bus
  sup: Supervisor
  registry: Registry
  tasks: Tasks
  approvals: Approvals
  manager: Manager
  router: Router
  routines: Routines
  connectors: ConnectorRegistry
  gateway: Gateway
  staff: Staff
  settings: Settings
  threads: Threads
  /** A second supervisor over the same data, as after a daemon restart. */
  restart(): Supervisor
  fake(mode?: string, more?: Record<string, string>): RunExtra
  cleanup(): void
}

/** `before` runs when the data folder exists and nothing has opened the database yet. */
export function makeWorld(before?: (home: Home) => void): World {
  // The folder's one true spelling: Windows also knows it by a short name (RUNNER~1), and git answers with the long one.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'heybotos-test-')))
  const home = openHome(root)
  before?.(home)
  home.config.keepAwake = false
  home.config.welcome = false
  home.config.tickMs = 15
  home.config.stopGraceMs = 150
  home.config.engines.claude.bin = FAKE
  home.config.engines.claude.env = { FAKE_FIXTURE: BASIC }
  home.config.engines.codex.bin = FAKE
  home.config.engines.codex.env = { FAKE_FIXTURE: join(FIXTURES, 'codex-basic.jsonl') }
  home.config.engines.grok.bin = FAKE
  home.config.engines.grok.env = { FAKE_FIXTURE: join(FIXTURES, 'grok-basic.jsonl') }
  home.config.projectRoots = [join(root, 'code')]
  home.config.notifications = false
  home.config.connectorsFile = join(root, 'claude.json')
  writeFileSync(
    home.config.connectorsFile,
    JSON.stringify({ mcpServers: { shopsystem: { type: 'http', url: 'https://shop.example/mcp', headers: { Authorization: 'Bearer shop-secret' } }, memory: { command: 'memory-server', args: ['--stdio'] } } }),
  )
  mkdirSync(join(root, 'code'))
  const db = new Db(home.dbPath)
  const bus = new Bus()
  const sups: Supervisor[] = []
  const make = () => {
    const s = new Supervisor(home, db, bus, { claude: claudeAdapter, codex: codexAdapter, grok: grokAdapter })
    sups.push(s)
    return s
  }
  const sup = make()
  const registry = new Registry(home, db)
  const tasks = new Tasks(home, db, bus, sup, registry)
  const approvals = new Approvals(home, db, bus, sup, tasks, loadGateConfig(home))
  const router = new Router(home, db, bus, sup, tasks)
  // Existing tests were written for one engine; routing has its own tests.
  router.cfg.mode = 'rules'
  router.cfg.byKind = { build: 'claude', review: 'claude', research: 'claude', write: 'claude', ops: 'claude', other: 'claude' }
  const manager = new Manager(home, db, bus, sup, tasks, registry)
  const routines = new Routines(db, manager)
  const connectors = new ConnectorRegistry(home, db)
  connectors.importOnce()
  const gateway = new Gateway(home, db, connectors, approvals)
  tasks.checkConnectors = (names) => connectors.check(names)
  sup.hubFor = (run) => ({ name: HUB, url: gateway.urlFor(run.id, approvals.url) })
  const staff = new Staff(db, manager)
  tasks.staff = staff
  const settings = new Settings({ home, manager, approvals, router, registry, connectors, supervisor: sup })
  return {
    threads: new Threads(db, registry),
    settings,
    staff,
    connectors,
    gateway,
    router,
    routines,
    registry,
    tasks,
    approvals,
    manager,
    root,
    home,
    db,
    bus,
    sup,
    restart: make,
    fake: (mode = 'ok', more = {}) => ({ env: { FAKE_FIXTURE: BASIC, FAKE_MODE: mode, ...more } }),
    cleanup() {
      manager.stop()
      for (const s of sups) s.shutdown()
      for (const r of db.all<{ pid: number | null }>('select pid from runs where pid is not null')) {
        killTree(r.pid!)
      }
      db.close()
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: WIN ? 3 : 0, retryDelay: 50 })
      } catch (e) {
        // Windows will not remove a folder while a file in it is open: a program that is just ending, or
        // (on the desktop app's runtime) the database for a moment after it was closed. The folder is
        // in the system's temporary files, so it is left there rather than waited for.
        if (!WIN) throw e
      }
    },
  }
}

export async function until(cond: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Write a changed copy of the basic fixture and return its path. */
export function variant(root: string, name: string, change: (lines: any[]) => any[], source = BASIC): string {
  const lines = readFileSync(source, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const path = join(root, `${name}.jsonl`)
  writeFileSync(path, change(lines).map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}
