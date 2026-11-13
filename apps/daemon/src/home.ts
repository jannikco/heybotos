// Where HeyBotOS keeps its state, and the user-editable config. Nothing user-specific lives in the repo.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { moveOldHome } from './migrate.ts'
import { findProgram, usualBinDirs } from './platform.ts'

export interface EngineConfig {
  /** Absolute path, or a bare name that is looked up on the worker PATH. */
  bin: string
  /** Empty = whatever the CLI defaults to. Model names live here, never in the repo. */
  model: string
  effort: string
  /** Extra variables added to the child environment on top of the allowlist. */
  env: Record<string, string>
}

export interface Config {
  port: number
  maxWorkers: number
  engines: { claude: EngineConfig; codex: EngineConfig; grok: EngineConfig }
  watchdog: {
    /** Stop a run that has produced no output for this long. */
    silentSeconds: number
    /** Stop a run that has been going for this long, whatever it is doing. */
    wallSeconds: number
  }
  /** Milliseconds between signal escalations when stopping a run. */
  stopGraceMs: number
  tickMs: number
  /** Hold a caffeinate assertion while workers run, so the Mac does not idle-sleep mid-task. */
  keepAwake: boolean
  /** Show the short welcome the first time the dashboard opens. The demo and the tests switch it off. */
  welcome: boolean
  /** Folders whose sub-folders are your projects. "~" is your home folder. */
  projectRoots: string[]
  /** macOS notifications when something lands in the inbox. */
  notifications: boolean
  /** Where your Claude Code connector (MCP server) definitions are read from. */
  connectorsFile: string
  updates: {
    /** Look for a newer version now and then. Nothing is installed without your say. */
    auto: boolean
    /** Empty = where the HeyBotOS project publishes its updates. A fork sets its own address and key. */
    url: string
    publicKey: string
  }
  manager: {
    /** Empty = the CLI's default. A smaller, faster model is usually right for managing. */
    model: string
    effort: string
    /** Worker reports are gathered for this long before the manager is woken, unless everything has settled. */
    batchSeconds: number
    /** Reports wait when the manager has already taken this many turns in the last hour. Your messages never wait. */
    maxTurnsPerHour: number
    /** A fresh manager session is started after this many turns, with a handoff from the task list. */
    rotateAfterTurns: number
  }
}

const DEFAULTS: Config = {
  port: 4747,
  maxWorkers: 3,
  engines: {
    claude: { bin: 'claude', model: '', effort: '', env: {} },
    codex: { bin: 'codex', model: '', effort: '', env: {} },
    grok: { bin: 'grok', model: '', effort: '', env: {} },
  },
  watchdog: { silentSeconds: 20 * 60, wallSeconds: 3 * 60 * 60 },
  stopGraceMs: 4000,
  tickMs: 120,
  keepAwake: true,
  welcome: true,
  // Filled in at first start with the usual places people keep their projects, where they exist.
  projectRoots: [],
  notifications: true,
  connectorsFile: '~/.claude.json',
  updates: { auto: true, url: '', publicKey: '' },
  manager: { model: '', effort: '', batchSeconds: 30, maxTurnsPerHour: 40, rotateAfterTurns: 40 },
}

export interface Home {
  root: string
  state: string
  runs: string
  manager: string
  projects: string
  worktrees: string
  /** Files people attached to tasks, comments and messages. */
  files: string
  configDir: string
  dbPath: string
  config: Config
  /** Shared secret for non-browser callers on this machine (curl, hooks, shims). */
  secret: string
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k]
    out[k] = b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v
  }
  return out as T
}

/** Where projects usually live. Only folders that are there; the same folder is never listed twice. */
export function usualProjectFolders(home = homedir()): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of ['GitHub', 'Code', 'Projects', 'Developer', 'dev', 'src', 'repos', 'workspace']) {
    const dir = join(home, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const real = realpathSync(dir).toLowerCase()
      if (seen.has(real)) continue
      seen.add(real)
      out.push(`~/${name}`)
    } catch {
      /* not there */
    }
  }
  return out
}

export function openHome(given?: string): Home {
  // An installation from when this was called BotOS is carried over, unless the folder was named by hand.
  if (!given && !process.env.HEYBOTOS_HOME) moveOldHome()
  const root = given || process.env.HEYBOTOS_HOME || join(homedir(), 'heybotos')
  const dirs = {
    root,
    state: join(root, 'state'),
    runs: join(root, 'state', 'runs'),
    manager: join(root, 'manager'),
    projects: join(root, 'projects'),
    worktrees: join(root, 'worktrees'),
    files: join(root, 'files'),
    configDir: join(root, 'config'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  chmodSync(dirs.state, 0o700)

  const configPath = join(dirs.configDir, 'heybotos.json')
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ ...DEFAULTS, projectRoots: usualProjectFolders() }, null, 2) + '\n')
  let config = DEFAULTS
  try {
    config = merge(DEFAULTS, JSON.parse(readFileSync(configPath, 'utf8')))
  } catch (e) {
    throw new Error(`Config file ${configPath} is not valid JSON: ${(e as Error).message}`)
  }

  const secretPath = join(dirs.state, 'secret')
  if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('hex'), { mode: 0o600 })
  const secret = readFileSync(secretPath, 'utf8').trim()

  return { ...dirs, dbPath: join(dirs.state, 'heybotos.db'), config, secret }
}

/**
 * PATH for workers. A background service is handed an almost empty PATH, and `codex` is a node
 * script, so the usual install locations are always appended.
 */
export function workerPath(): string {
  return [...new Set([...(process.env.PATH ?? '').split(delimiter), ...usualBinDirs()].filter(Boolean))].join(delimiter)
}

/** Find a program by bare name on the worker PATH. A path to a file is returned if the file is there. */
export function findBin(bin: string): string | null {
  return findProgram(bin, workerPath())
}
