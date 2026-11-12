// Which engine does a task go to, and what happens when a subscription runs out.
//
// Two modes (~/heybotos/config/routing.json, or Settings):
//   balanced  the engines are one pool. A new task goes to whichever has room and the fewest
//             workers out, so three subscriptions share the load; a review goes to a different
//             engine than the work it reviews.
//   rules     each kind of work has its engine.
// In both, a usage-limit signal puts that engine on hold until the limit resets: work that has not
// started moves to another engine, a worker that was cut off waits and resumes its own session.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine, EngineUsage, RoutingView, TaskKind } from '@heybotos/protocol'
import type { Bus } from './bus.ts'
import type { Db } from './db.ts'
import type { Home } from './home.ts'
import type { Tasks } from './tasks.ts'
import type { Supervisor } from './engines/supervisor.ts'
import { engineHealth } from './health.ts'

export const ENGINES: Engine[] = ['claude', 'codex', 'grok']

export interface RoutingConfig {
  mode: 'balanced' | 'rules'
  /** The engines that share the load in balanced mode. */
  pool: Engine[]
  /** Which engine does each kind of work in rules mode (and the first choice when nothing has room). */
  byKind: Record<TaskKind, Engine>
  /** Use another engine when the chosen one is on hold or not signed in. */
  fallback: boolean
  /** Do not start new workers on an engine once a limit window is this full (0–1). Leaves room for your own use. */
  headroom: Record<Engine, number>
  /** How long to hold an engine when it reports a limit without saying when it resets. */
  defaultCooldownMinutes: number
}

const DEFAULTS: RoutingConfig = {
  mode: 'balanced',
  pool: ['claude', 'codex', 'grok'],
  byKind: { build: 'claude', review: 'codex', research: 'claude', write: 'claude', ops: 'claude', other: 'claude' },
  fallback: true,
  headroom: { claude: 0.95, codex: 1, grok: 1 },
  defaultCooldownMinutes: 30,
}

interface WindowReading {
  window: string
  utilization: number | null
  resetsAt: number | null
  status: string
  at: number
}
interface EngineState {
  coolingUntil: number | null
  windows: Record<string, WindowReading>
}

const NAME: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }
const fresh = (): Record<Engine, EngineState> => ({ claude: { coolingUntil: null, windows: {} }, codex: { coolingUntil: null, windows: {} }, grok: { coolingUntil: null, windows: {} } })

export class Router {
  private home: Home
  private db: Db
  private supervisor: Supervisor
  private tasks: Tasks
  private file: string
  private timer: NodeJS.Timeout | null = null
  private state: Record<Engine, EngineState> = fresh()
  /** From the health check; an engine that is not installed or not signed in gets no work. */
  private ready: Record<Engine, boolean> = { claude: true, codex: true, grok: true }
  /** When each engine was last given a task, to break ties evenly. */
  private lastPick: Record<Engine, number> = { claude: 0, codex: 0, grok: 0 }
  private picks = 0
  cfg: RoutingConfig

  constructor(home: Home, db: Db, bus: Bus, supervisor: Supervisor, tasks: Tasks) {
    this.home = home
    this.db = db
    this.supervisor = supervisor
    this.tasks = tasks
    this.file = join(home.configDir, 'routing.json')
    if (!existsSync(this.file)) writeFileSync(this.file, JSON.stringify(DEFAULTS, null, 2) + '\n')
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RoutingConfig>
      this.cfg = { ...DEFAULTS, ...saved, byKind: { ...DEFAULTS.byKind, ...(saved.byKind ?? {}) }, headroom: { ...DEFAULTS.headroom, ...(saved.headroom ?? {}) } }
    } catch (e) {
      throw new Error(`Routing settings file ${this.file} is not valid JSON: ${(e as Error).message}`)
    }
    const saved = db.get<{ value: string }>(`select value from meta where key = 'engine_state'`)
    if (saved) {
      try {
        this.state = { ...fresh(), ...(JSON.parse(saved.value) as Record<Engine, EngineState>) }
      } catch {
        /* start fresh */
      }
    }

    tasks.chooseEngine = (kind, avoid) => this.pick(kind, avoid)
    tasks.whyHeld = (engine) => this.whyHeld(engine)
    supervisor.admission = (run) => (run.role === 'manager' ? !this.cooling(run.engine) : this.mayStart(run.engine))
    bus.on('limit', (l) => this.onLimit(l.engine, l))
  }

  start(): void {
    void this.refreshHealth()
    this.timer = setInterval(() => this.tick(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refreshHealth(): Promise<void> {
    try {
      for (const e of await engineHealth(this.home)) this.ready[e.engine] = e.loggedIn
    } catch {
      /* keep the last known state */
    }
  }

  /** Tests and the health page can say directly whether an engine is usable. */
  setReady(engine: Engine, ready: boolean): void {
    this.ready[engine] = ready
  }

  private save(): void {
    this.db.run(`insert into meta (key, value) values ('engine_state', ?) on conflict(key) do update set value = excluded.value`, JSON.stringify(this.state))
  }

  // ── decisions ────────────────────────────────────────────────────────────────────────────

  cooling(engine: Engine, now = Date.now()): boolean {
    const until = this.state[engine].coolingUntil
    return until !== null && until > now
  }

  /** How full the fullest limit window is, from readings that are still current. */
  private fullness(engine: Engine, now = Date.now()): number {
    let max = 0
    for (const w of Object.values(this.state[engine].windows)) {
      // A reading for a window that has since reset says nothing about now.
      if (w.resetsAt !== null && w.resetsAt * 1000 <= now) continue
      if (w.utilization !== null) max = Math.max(max, w.utilization)
    }
    return max
  }

  /** May a new worker start on this engine right now? */
  mayStart(engine: Engine, now = Date.now()): boolean {
    return this.ready[engine] && !this.cooling(engine, now) && this.fullness(engine, now) < this.cfg.headroom[engine]
  }

  /** Workers out or queued on an engine right now. */
  private load(engine: Engine): number {
    return this.db.get<{ n: number }>(`select count(*) as n from runs where engine = ? and status in ('queued','starting','running','stopping') and coalesce(role, '') != 'manager'`, engine)?.n ?? 0
  }

  /** Engines that can take work now, the least busy first; ties go to whoever was picked longest ago. */
  private open(among: Engine[], now = Date.now()): Engine[] {
    return among.filter((e) => this.mayStart(e, now)).sort((a, b) => this.load(a) - this.load(b) || this.lastPick[a] - this.lastPick[b])
  }

  /**
   * The engine for a new task of this kind. `avoid` is the engine whose work the task checks:
   * a second opinion is worth more from a different one.
   */
  pick(kind: TaskKind, avoid?: Engine): Engine {
    const preferred = this.cfg.byKind[kind] ?? 'claude'
    let choice: Engine
    if (this.cfg.mode === 'balanced') {
      const pool = this.cfg.pool.length ? this.cfg.pool : ENGINES
      const open = this.open(pool)
      choice = open.find((e) => e !== avoid) ?? open[0] ?? (pool.includes(preferred) ? preferred : pool[0]!)
    } else if (this.mayStart(preferred) || !this.cfg.fallback) {
      choice = preferred
    } else {
      choice = this.open(ENGINES.filter((e) => e !== preferred))[0] ?? preferred
    }
    this.lastPick[choice] = ++this.picks
    return choice
  }

  whyHeld(engine: Engine, now = Date.now()): string | null {
    if (!this.ready[engine]) return `${NAME[engine]} is not signed in with a subscription. See Health.`
    const until = this.state[engine].coolingUntil
    if (until !== null && until > now) return `${NAME[engine]}'s usage limit is used up. It resets at ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    if (this.fullness(engine, now) >= this.cfg.headroom[engine]) return `${NAME[engine]} is at ${Math.round(this.fullness(engine, now) * 100)}% of its usage limit; new workers are held back to leave room for you.`
    return null
  }

  // ── limits ───────────────────────────────────────────────────────────────────────────────

  private onLimit(engine: Engine, l: { rejected: boolean; resetsAt: number | null; utilization: number | null; window?: string | null; status?: string }): void {
    const now = Date.now()
    const key = l.window ?? 'limit'
    this.state[engine].windows[key] = { window: key, utilization: l.rejected ? 1 : l.utilization, resetsAt: l.resetsAt, status: l.status ?? (l.rejected ? 'rejected' : 'allowed'), at: now }
    if (l.rejected) {
      const until = l.resetsAt !== null && l.resetsAt * 1000 > now ? l.resetsAt * 1000 : now + this.cfg.defaultCooldownMinutes * 60_000
      this.state[engine].coolingUntil = Math.max(this.state[engine].coolingUntil ?? 0, until)
      this.reroute(engine)
    }
    this.save()
  }

  /** Work that has not started moves to another engine, if one can take it. */
  private reroute(from: Engine): void {
    if (!this.cfg.fallback && this.cfg.mode !== 'balanced') return
    const others = (this.cfg.mode === 'balanced' && this.cfg.pool.length ? this.cfg.pool : ENGINES).filter((e) => e !== from)
    const queued = this.db.all<{ id: string; task_id: string | null }>(`select id, task_id from runs where status = 'queued' and engine = ? and turn = 1 and coalesce(role, '') != 'manager'`, from)
    for (const r of queued) {
      const to = this.open(others)[0]
      if (!to) break
      if (this.supervisor.reassign(r.id, to) && r.task_id) this.tasks.setEngine(r.task_id, to)
    }
    this.supervisor.nudge()
  }

  /** Lift cooldowns that have run out and wake what was waiting for them. */
  tick(now = Date.now()): void {
    let lifted = false
    const resumed: Engine[] = []
    for (const engine of ENGINES) {
      // A reading for a limit window that has since reset says nothing any more.
      for (const [key, w] of Object.entries(this.state[engine].windows)) {
        if (w.resetsAt !== null && w.resetsAt * 1000 <= now) {
          delete this.state[engine].windows[key]
          lifted = true
        }
      }
      const until = this.state[engine].coolingUntil
      if (until !== null && until <= now) {
        this.state[engine].coolingUntil = null
        lifted = true
        resumed.push(engine)
      }
    }
    if (lifted) this.save()
    for (const engine of resumed) this.tasks.resumeLimited(engine)
    this.supervisor.nudge()
  }

  // ── for the dashboard ────────────────────────────────────────────────────────────────────

  usage(now = Date.now()): EngineUsage[] {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return ENGINES.map((engine) => {
      const today = this.db.get<{ n: number; t: number | null }>('select count(*) as n, sum(tokens_out) as t from runs where engine = ? and created_at >= ?', engine, midnight.getTime())
      const working = this.db.get<{ n: number }>(`select count(*) as n from runs where engine = ? and status in ('starting','running','stopping')`, engine)
      return {
        engine,
        ready: this.ready[engine],
        coolingUntil: this.cooling(engine, now) ? this.state[engine].coolingUntil : null,
        windows: Object.values(this.state[engine].windows)
          .filter((w) => w.resetsAt === null || w.resetsAt * 1000 > now)
          .sort((a, b) => a.window.localeCompare(b.window)),
        headroom: this.cfg.headroom[engine],
        runsToday: today?.n ?? 0,
        tokensOutToday: today?.t ?? 0,
        workingNow: working?.n ?? 0,
      }
    })
  }

  routing(): RoutingView {
    return { mode: this.cfg.mode, pool: this.cfg.pool, byKind: this.cfg.byKind, fallback: this.cfg.fallback, file: this.file }
  }
}
