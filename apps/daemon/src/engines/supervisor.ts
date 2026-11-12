// Owns every worker process.
//
// Lessons this is built on (from CodeCockpit, nightdesk and myclaw):
// - the prompt goes to stdin, never argv;
// - a worker's stdout goes to a file, and the daemon tails that file with a stored offset, so the
//   daemon can die and come back without losing a line or killing the worker;
// - each worker is its own process group, so stopping it stops everything it started;
// - there is exactly one owner of timeouts (this file);
// - success is read from the CLI's own result line, never from the exit code.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { CreateRunInput, Engine, RunStatus, RunView, StoredEvent, WorkerReport } from '@heybotos/protocol'
import type { Db } from '../db.ts'
import type { Bus } from '../bus.ts'
import { findBin, type Home } from '../home.ts'
import { childEnv } from './env.ts'
import { oneLine } from './redact.ts'
import { REPORT_SCHEMA } from './report.ts'
import type { EngineAdapter, FinalResult, LineParser, SpawnSpec } from './types.ts'

export interface RunRow {
  id: string
  task_id: string | null
  engine: Engine
  role: string | null
  title: string
  prompt: string
  cwd: string
  session_id: string | null
  turn: number
  status: RunStatus
  pid: number | null
  pid_started: string | null
  model: string | null
  effort: string | null
  activity: string | null
  error: string | null
  result_text: string | null
  report_json: string | null
  cost_usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  stdout_path: string | null
  stdout_offset: number
  stop_requested: number
  stop_reason: string | null
  lock_key: string | null
  limited: number
  extra_json: string | null
  created_at: number
  started_at: number | null
  ended_at: number | null
}

/** Per-run options that are not columns. */
export interface RunExtra {
  /** Role and house rules appended to the CLI's system prompt. */
  systemPrompt?: string
  /** Ask for the structured worker report. */
  wantReport?: boolean
  /** MCP servers this run may use, in the CLI's config shape. Default: none. */
  mcpConfig?: Record<string, unknown>
  /** Names of the owner's connectors this run may use. It reaches them through HeyBotOS's gateway, never directly. */
  connectors?: string[]
  /** The worker reads text other people wrote (orders, messages), so it gets no shell to act on it. */
  noShell?: boolean
  /** Claude settings object (carries the gate hook). */
  settings?: Record<string, unknown>
  tools?: string[]
  pathPrefix?: string[]
  env?: Record<string, string>
}

export interface NewRun extends CreateRunInput {
  sessionId?: string | null
  turn?: number
  extra?: RunExtra
  /** Only one worker at a time may hold a lock key (a repository, usually). Default: the folder. */
  lockKey?: string
}

interface ActiveRun {
  id: string
  engine: Engine
  pid: number
  child: ChildProcess | null
  exited: boolean
  parser: LineParser
  path: string
  lastOutputAt: number
  startedAt: number
  /** 0 = not stopping, 1 = INT sent, 2 = TERM sent, 3 = KILL sent. */
  stopStage: number
  stopAt: number
  final: FinalResult | null
  finalAt: number
  fatal: string | null
  /** The engine said its usage limit is used up during this turn. */
  limited: boolean
}

const ACTIVE: RunStatus[] = ['starting', 'running', 'stopping']
const MAX_READ = 1024 * 1024
const NEWLINE = 0x0a

/** Which events are worth a mark on a run's activity strip, and what kind of mark. */
export function pulseKind(e: Pick<StoredEvent, 'kind' | 'data'>): 'tool' | 'handoff' | 'say' | 'error' | null {
  if (e.kind === 'tool_start') return e.data.subagent === true ? 'handoff' : 'tool'
  if (e.kind === 'text') return 'say'
  if (e.kind === 'error') return 'error'
  if (e.kind === 'tool_result' && e.data.isError === true) return 'error'
  return null
}

export function toView(r: RunRow): RunView {
  let report: WorkerReport | null = null
  if (r.report_json) {
    try {
      report = JSON.parse(r.report_json)
    } catch {
      report = null
    }
  }
  return {
    id: r.id,
    taskId: r.task_id,
    engine: r.engine,
    role: r.role,
    title: r.title,
    prompt: r.prompt,
    cwd: r.cwd,
    sessionId: r.session_id,
    turn: r.turn,
    status: r.status,
    model: r.model,
    activity: r.activity,
    error: r.error,
    resultText: r.result_text,
    report,
    costUsd: r.cost_usd,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    limited: r.limited === 1,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Start time as the OS reports it; pid + start time identifies a process across daemon restarts. */
function pidStarted(pid: number): string | null {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      /* already gone */
    }
  }
}

export class Supervisor {
  private active = new Map<string, ActiveRun>()
  private timer: NodeJS.Timeout | null = null
  private lastTick = Date.now()
  private awake: ChildProcess | null = null
  /** The scheduler plugs in here to hold back runs (cooldowns, pause switch). */
  admission: (run: RunRow) => boolean = () => true
  /** Called just before a worker process starts; a throw here fails the run with that message. */
  beforeSpawn: (run: RunRow) => void = () => {}
  /** Where a run reaches the gateway to the owner's connectors (an address that carries its own pass), or null. */
  hubFor: (run: RunRow) => { name: string; url: string } | null = () => null
  /** Adds what every worker gets on top of its own options (the gate hook and its PATH wrappers). */
  decorate: (run: RunRow, extra: RunExtra) => RunExtra = (_run, extra) => extra

  private home: Home
  private db: Db
  private bus: Bus
  private adapters: Partial<Record<Engine, EngineAdapter>>

  constructor(home: Home, db: Db, bus: Bus, adapters: Partial<Record<Engine, EngineAdapter>>) {
    this.home = home
    this.db = db
    this.bus = bus
    this.adapters = adapters
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────

  start(): void {
    this.reconcile()
    this.timer = setInterval(() => this.safeTick(), this.home.config.tickMs)
  }

  /** Stop supervising. Workers are left running on purpose; the next start picks them up. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.awake?.kill()
    this.awake = null
  }

  activeCount(): number {
    return this.active.size
  }

  // ── queries ──────────────────────────────────────────────────────────────────────────────

  row(id: string): RunRow | undefined {
    return this.db.get<RunRow>('select * from runs where id = ?', id)
  }

  list(limit = 200): RunView[] {
    return this.db.all<RunRow>('select * from runs order by created_at desc, rowid desc limit ?', limit).map(toView)
  }

  view(id: string): RunView | undefined {
    const r = this.row(id)
    return r ? toView(r) : undefined
  }

  events(runId: string, afterId = 0, limit = 5000): StoredEvent[] {
    return this.db
      .all<{ id: number; run_id: string; ts: number; kind: StoredEvent['kind']; parent: string | null; data: string }>(
        'select * from events where run_id = ? and id > ? order by id limit ?',
        runId,
        afterId,
        limit,
      )
      .map((e) => ({ id: e.id, runId: e.run_id, ts: e.ts, kind: e.kind, parent: e.parent, data: JSON.parse(e.data) }))
  }

  pulse(runId: string, limit = 600): Array<[number, string]> {
    const run = this.row(runId)
    if (!run) return []
    const out: Array<[number, string]> = []
    for (const e of this.events(runId, 0, 20_000)) {
      const kind = pulseKind(e)
      if (kind) out.push([Math.round((e.ts - (run.started_at ?? run.created_at)) / 100) / 10, kind])
    }
    return out.slice(-limit)
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────

  create(input: NewRun): RunView {
    if (!this.adapters[input.engine]) throw new Error(`Engine "${input.engine}" is not available yet.`)
    let isDir = false
    try {
      isDir = statSync(input.cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new Error(`Folder does not exist: ${input.cwd}`)
    if (!input.prompt.trim()) throw new Error('The prompt is empty.')

    const cfg = this.home.config.engines[input.engine]
    const id = `r_${randomBytes(5).toString('hex')}`
    const turn = input.turn ?? 1
    // Claude lets us choose the session id up front; Codex reports its own on the first line.
    const sessionId = input.sessionId ?? (this.adapters[input.engine]?.ownsSessionId && turn === 1 ? randomUUID() : null)
    this.db.run(
      `insert into runs (id, task_id, engine, role, title, prompt, cwd, session_id, turn, status, model, effort, extra_json, lock_key, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      id,
      input.taskId ?? null,
      input.engine,
      input.role ?? null,
      input.title?.trim() || oneLine(input.prompt, 72),
      input.prompt,
      input.cwd,
      sessionId,
      turn,
      input.model || cfg.model || null,
      input.effort || cfg.effort || null,
      input.extra ? JSON.stringify(input.extra) : null,
      input.lockKey ?? input.cwd,
      Date.now(),
    )
    this.publish(id)
    this.pump()
    return this.view(id)!
  }

  /** Next turn of the same agent session: a new process that resumes where the last one ended. */
  continue(prevId: string, prompt: string): RunView {
    const prev = this.row(prevId)
    if (!prev) throw new Error('No such run.')
    if (['queued', ...ACTIVE].includes(prev.status)) throw new Error('That agent is still working; stop it or wait for it to finish.')
    if (!prev.session_id) throw new Error('That run never got a session, so there is nothing to continue. Start a new one.')
    return this.create({
      engine: prev.engine,
      cwd: prev.cwd,
      prompt,
      title: prev.title,
      role: prev.role ?? undefined,
      model: prev.model ?? undefined,
      effort: prev.effort ?? undefined,
      taskId: prev.task_id ?? undefined,
      sessionId: prev.session_id,
      turn: prev.turn + 1,
      extra: prev.extra_json ? JSON.parse(prev.extra_json) : undefined,
      lockKey: prev.lock_key ?? undefined,
    })
  }

  stop(id: string, reason = 'user'): RunView {
    const r = this.row(id)
    if (!r) throw new Error('No such run.')
    if (r.status === 'queued') {
      this.db.run(`update runs set status = 'cancelled', stop_requested = 1, stop_reason = ?, ended_at = ? where id = ?`, reason, Date.now(), id)
      this.publish(id, true)
      return this.view(id)!
    }
    const a = this.active.get(id)
    if (!a) return toView(r)
    if (a.stopStage === 0) {
      this.db.run(`update runs set status = 'stopping', stop_requested = 1, stop_reason = ? where id = ?`, reason, id)
      a.stopStage = 1
      a.stopAt = Date.now() + this.home.config.stopGraceMs
      // INT first: the CLI then writes a result line and saves the session. TERM and KILL follow.
      signalGroup(a.pid, 'SIGINT')
      this.publish(id)
    }
    return this.view(id)!
  }

  /** Move a run that has not started yet to the other engine (used when its engine hits a limit). */
  reassign(id: string, engine: Engine): boolean {
    const r = this.row(id)
    if (!r || r.status !== 'queued' || r.turn !== 1 || r.engine === engine || !this.adapters[engine]) return false
    const cfg = this.home.config.engines[engine]
    this.db.run('update runs set engine = ?, session_id = ?, model = ?, effort = ? where id = ?', engine, this.adapters[engine]?.ownsSessionId ? randomUUID() : null, cfg.model || null, cfg.effort || null, id)
    this.publish(id)
    return true
  }

  /** Give queued runs another chance to start (called when a cooldown ends or a pause is lifted). */
  nudge(): void {
    this.pump()
  }

  // ── start-up ─────────────────────────────────────────────────────────────────────────────

  /** After a daemon restart: adopt workers that are still alive, finalise the ones that are not. */
  private reconcile(): void {
    const rows = this.db.all<RunRow>(`select * from runs where status in ('starting','running','stopping')`)
    for (const r of rows) {
      const adapter = this.adapters[r.engine]
      const a: ActiveRun = {
        id: r.id,
        engine: r.engine,
        pid: r.pid ?? 0,
        child: null,
        exited: true,
        parser: adapter ? adapter.createParser() : () => ({ events: [], deltas: [] }),
        path: r.stdout_path ?? '',
        lastOutputAt: Date.now(),
        startedAt: r.started_at ?? Date.now(),
        stopStage: 0,
        stopAt: 0,
        final: null,
        finalAt: 0,
        fatal: null,
        limited: false,
      }
      const same = r.pid !== null && alive(r.pid) && pidStarted(r.pid) === r.pid_started
      if (same) {
        a.exited = false
        if (r.status === 'stopping') {
          a.stopStage = 1
          a.stopAt = Date.now()
        }
        this.active.set(r.id, a)
      } else {
        this.drain(a, true)
        this.finalise(a)
      }
    }
    this.keepAwake()
  }

  // ── spawning ─────────────────────────────────────────────────────────────────────────────

  /** Workers in flight. The manager has a seat of its own, so three busy workers never lock you out of it. */
  private workersActive(): number {
    const row = this.db.get<{ n: number }>(`select count(*) as n from runs where status in ('starting','running','stopping') and coalesce(role, '') != 'manager'`)
    return row?.n ?? 0
  }

  private pump(): void {
    const queued = this.db.all<RunRow>(`select * from runs where status = 'queued' order by created_at, rowid`)
    if (!queued.length) return
    let workers = this.workersActive()
    // One worker per lock key: two agents editing the same repository would trample each other.
    const held = new Set(
      this.db.all<{ lock_key: string | null }>(`select lock_key from runs where status in ('starting','running','stopping')`).map((x) => x.lock_key),
    )
    for (const r of queued) {
      const isManager = r.role === 'manager'
      if (!isManager && workers >= this.home.config.maxWorkers) continue
      if (r.lock_key && held.has(r.lock_key)) continue
      if (!this.admission(r)) continue
      try {
        this.beforeSpawn(r)
      } catch (e) {
        this.fail(r.id, (e as Error).message)
        continue
      }
      this.spawnRun(r)
      held.add(r.lock_key)
      if (!isManager) workers++
    }
  }

  private fail(id: string, message: string): void {
    this.db.run(`update runs set status = 'failed', error = ?, ended_at = ? where id = ?`, message, Date.now(), id)
    this.storeEvents(id, [{ kind: 'error', parent: null, data: { message } }])
    this.publish(id, true)
  }

  private spawnRun(r: RunRow): void {
    const adapter = this.adapters[r.engine]!
    const cfg = this.home.config.engines[r.engine]
    const bin = findBin(cfg.bin)
    if (!bin) {
      this.fail(r.id, `Could not find the ${r.engine} command-line tool ("${cfg.bin}"). Install it or set its path in ${join(this.home.configDir, 'heybotos.json')}.`)
      return
    }
    const dir = join(this.home.runs, r.id)
    mkdirSync(dir, { recursive: true })
    const extra: RunExtra = this.decorate(r, r.extra_json ? JSON.parse(r.extra_json) : {})

    const spec: SpawnSpec = {
      runId: r.id,
      cwd: r.cwd,
      sessionId: r.session_id,
      turn: r.turn,
      model: r.model ?? '',
      effort: r.effort ?? '',
      tools: extra.tools,
    }
    if (extra.systemPrompt) {
      spec.systemPromptFile = join(dir, 'system.md')
      writeFileSync(spec.systemPromptFile, extra.systemPrompt)
    }
    if (extra.wantReport) {
      spec.reportSchemaJson = JSON.stringify(REPORT_SCHEMA)
      spec.reportSchemaFile = join(dir, 'report.schema.json')
      writeFileSync(spec.reportSchemaFile, spec.reportSchemaJson)
    }
    spec.runDir = dir
    spec.noShell = extra.noShell === true
    const hub = extra.connectors?.length ? this.hubFor(r) : null
    if (hub) spec.hub = hub
    if (extra.mcpConfig || hub) {
      const own = (extra.mcpConfig as { mcpServers?: Record<string, unknown> } | undefined)?.mcpServers ?? {}
      spec.mcpConfigFile = join(dir, 'mcp.json')
      // Carries this run's pass to the gateway (and the manager's token): readable by the owner only.
      writeFileSync(spec.mcpConfigFile, JSON.stringify({ mcpServers: { ...(hub ? { [hub.name]: { type: 'http', url: hub.url } } : {}), ...own } }), { mode: 0o600 })
    }
    if (extra.settings) {
      spec.settingsFile = join(dir, 'settings.json')
      writeFileSync(spec.settingsFile, JSON.stringify(extra.settings), { mode: 0o600 })
    }

    const prompt = adapter.wrapPrompt ? adapter.wrapPrompt(spec, r.prompt) : r.prompt
    if (adapter.promptFromFile) {
      spec.promptFile = join(dir, 'prompt.txt')
      writeFileSync(spec.promptFile, prompt)
    }
    const stdoutPath = join(dir, 'stdout.jsonl')
    const out = openSync(stdoutPath, 'a')
    const err = openSync(join(dir, 'stderr.log'), 'a')
    let child: ChildProcess
    try {
      const env = childEnv({ runId: r.id, pathPrefix: extra.pathPrefix, extra: { ...cfg.env, ...(extra.env ?? {}) } })
      spec.bin = bin
      spec.env = env
      child = spawn(bin, adapter.buildArgs(spec), {
        cwd: r.cwd,
        env,
        stdio: ['pipe', out, err],
        detached: true, // own session and process group; survives the daemon
      })
    } catch (e) {
      closeSync(out)
      closeSync(err)
      this.fail(r.id, `Could not start ${r.engine}: ${(e as Error).message}`)
      return
    }
    closeSync(out)
    closeSync(err)

    if (!child.pid) {
      child.once('error', (e) => this.fail(r.id, `Could not start ${r.engine}: ${e.message}`))
      return
    }

    const now = Date.now()
    const a: ActiveRun = {
      id: r.id,
      engine: r.engine,
      pid: child.pid,
      child,
      exited: false,
      parser: adapter.createParser(),
      path: stdoutPath,
      lastOutputAt: now,
      startedAt: now,
      stopStage: 0,
      stopAt: 0,
      final: null,
      finalAt: 0,
      fatal: null,
      limited: false,
    }
    child.once('exit', () => {
      a.exited = true
    })
    child.once('error', () => {
      a.exited = true
    })
    // The whole prompt, then EOF. A worker that dies early closes the pipe; that is not our crash.
    child.stdin?.on('error', () => {})
    child.stdin?.end(adapter.promptFromFile ? '' : prompt)
    child.unref()

    this.db.run(
      `update runs set status = 'starting', pid = ?, pid_started = ?, stdout_path = ?, started_at = ? where id = ?`,
      child.pid,
      pidStarted(child.pid),
      stdoutPath,
      now,
      r.id,
    )
    this.active.set(r.id, a)
    this.keepAwake()
    this.publish(r.id)
  }

  // ── the loop ─────────────────────────────────────────────────────────────────────────────

  private safeTick(): void {
    try {
      this.tick()
    } catch (e) {
      console.error('[supervisor] tick failed:', e)
    }
  }

  /** Public so tests can drive time by hand. */
  tick(now = Date.now()): void {
    // A long gap between ticks means the Mac slept. That time must not count against a worker.
    const gap = now - this.lastTick
    this.lastTick = now
    if (gap > 30_000) {
      for (const a of this.active.values()) {
        a.lastOutputAt += gap
        a.startedAt += gap
        if (a.stopAt) a.stopAt += gap
      }
    }

    const { watchdog, stopGraceMs } = this.home.config
    for (const a of [...this.active.values()]) {
      this.drain(a, false)

      if (!a.exited && !a.child && !alive(a.pid)) a.exited = true
      if (a.exited) {
        this.drain(a, true)
        this.finalise(a)
        continue
      }

      if (a.fatal && a.stopStage < 3) {
        // Billing protection: no grace period.
        a.stopStage = 3
        signalGroup(a.pid, 'SIGKILL')
        continue
      }
      // The CLI printed its result but is still around (a lingering child, usually).
      if (a.final && a.stopStage === 0 && now - a.finalAt > 10_000) {
        a.stopStage = 2
        a.stopAt = now + stopGraceMs
        signalGroup(a.pid, 'SIGTERM')
      }
      if (a.stopStage === 0 && !a.final) {
        if (now - a.lastOutputAt > watchdog.silentSeconds * 1000) {
          this.stop(a.id, `No output for ${Math.round(watchdog.silentSeconds / 60)} minutes, so it was stopped.`)
        } else if (now - a.startedAt > watchdog.wallSeconds * 1000) {
          this.stop(a.id, `Still running after ${Math.round(watchdog.wallSeconds / 60)} minutes, so it was stopped.`)
        }
      }
      if (a.stopStage > 0 && a.stopStage < 3 && now >= a.stopAt) {
        a.stopStage++
        a.stopAt = now + stopGraceMs
        signalGroup(a.pid, a.stopStage === 2 ? 'SIGTERM' : 'SIGKILL')
      }
    }
    this.pump()
  }

  /**
   * Read what the worker has written since the stored offset and turn it into events.
   * Only whole lines are consumed, and the offset moves in the same transaction as the events,
   * so a crash between the two can neither lose nor repeat a line.
   */
  private drain(a: ActiveRun, atEnd: boolean): void {
    if (!a.path || !existsSync(a.path)) return
    for (;;) {
      const row = this.db.get<{ stdout_offset: number; status: RunStatus; turn: number }>('select stdout_offset, status, turn from runs where id = ?', a.id)
      if (!row) return
      let size = 0
      try {
        size = statSync(a.path).size
      } catch {
        return
      }
      if (size <= row.stdout_offset) return
      const want = Math.min(size - row.stdout_offset, MAX_READ)
      const buf = Buffer.allocUnsafe(want)
      const fd = openSync(a.path, 'r')
      let got = 0
      try {
        got = readSync(fd, buf, 0, want, row.stdout_offset)
      } finally {
        closeSync(fd)
      }
      if (got <= 0) return
      let end = buf.subarray(0, got).lastIndexOf(NEWLINE)
      // At the very end a last line without a newline still counts.
      if (end < 0 && atEnd && row.stdout_offset + got >= size) end = got - 1
      // A single line longer than the read window: take it as it is rather than stall forever.
      if (end < 0 && got === MAX_READ) end = got - 1
      if (end < 0) return
      const consumed = end + 1
      const lines = buf.subarray(0, consumed).toString('utf8').split('\n').filter((l) => l.trim() !== '')

      a.lastOutputAt = Date.now()
      const events: Array<Omit<StoredEvent, 'id' | 'runId' | 'ts'>> = []
      const deltas: Array<{ parent: string | null; channel: 'text' | 'thinking'; text: string }> = []
      const patch: { sessionId?: string; model?: string; activity?: string } = {}
      for (const line of lines) {
        const p = a.parser(line)
        events.push(...p.events)
        deltas.push(...p.deltas)
        Object.assign(patch, p.patch ?? {})
        if (p.fatal && !a.fatal) a.fatal = p.fatal
        if (p.final) {
          a.final = p.final
          a.finalAt = Date.now()
        }
        if (p.limit) {
          if (p.limit.rejected) a.limited = true
          this.bus.emit('limit', { engine: a.engine, ...p.limit })
        }
      }

      let stored: StoredEvent[] = []
      this.db.tx(() => {
        stored = this.storeEvents(a.id, events, false)
        this.db.run(
          `update runs set stdout_offset = ?,
             status = case when status = 'starting' then 'running' else status end,
             session_id = coalesce(?, session_id),
             model = coalesce(?, model),
             activity = coalesce(?, activity)
           where id = ?`,
          row.stdout_offset + consumed,
          // A resumed session keeps its id; only a first turn may learn one from the CLI.
          row.turn === 1 ? (patch.sessionId ?? null) : null,
          patch.model ?? null,
          patch.activity ?? null,
          a.id,
        )
      })
      for (const e of stored) this.bus.emit('event', e)
      for (const d of deltas) this.bus.emit('delta', { runId: a.id, ...d })
      if (row.status === 'starting' || patch.activity || patch.sessionId || patch.model) this.publish(a.id)
      if (row.stdout_offset + consumed >= size) return
    }
  }

  private storeEvents(runId: string, events: Array<Omit<StoredEvent, 'id' | 'runId' | 'ts'>>, emit = true): StoredEvent[] {
    const ts = Date.now()
    const stored: StoredEvent[] = []
    this.db.tx(() => {
      for (const e of events) {
        const { lastId } = this.db.run('insert into events (run_id, ts, kind, parent, data) values (?, ?, ?, ?, ?)', runId, ts, e.kind, e.parent, JSON.stringify(e.data))
        stored.push({ id: lastId, runId, ts, kind: e.kind, parent: e.parent, data: e.data })
      }
    })
    if (emit) for (const e of stored) this.bus.emit('event', e)
    return stored
  }

  private stderrTail(a: ActiveRun): string {
    try {
      const text = readFileSync(join(this.home.runs, a.id, 'stderr.log'), 'utf8').trim()
      return text.split('\n').slice(-6).join('\n').slice(-1200)
    } catch {
      return ''
    }
  }

  private finalise(a: ActiveRun): void {
    this.active.delete(a.id)
    const r = this.row(a.id)
    if (!r) return
    const f = a.final
    let status: RunStatus
    let error: string | null = null
    if (a.fatal) {
      status = 'failed'
      error = a.fatal
    } else if (r.stop_requested && r.stop_reason === 'user') {
      // The person pressed stop. Whatever the CLI managed to say on the way out is kept below.
      status = 'cancelled'
    } else if (r.stop_requested) {
      status = 'failed'
      error = r.stop_reason
    } else if (f) {
      status = f.status
      error = f.error
      if (status === 'done' && r.extra_json && (JSON.parse(r.extra_json) as RunExtra).wantReport && !f.report) {
        status = 'failed'
        error = 'It finished without handing in its report, so the result cannot be trusted as done.'
      }
    } else {
      status = 'interrupted'
      const tail = this.stderrTail(a)
      error = tail ? `The ${r.engine} process ended without a result. Last output:\n${tail}` : `The ${r.engine} process ended without a result.`
    }
    this.db.run(
      `update runs set status = ?, limited = ?, error = ?, result_text = ?, report_json = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, ended_at = ?, activity = null where id = ?`,
      status,
      // Only a turn that did not finish counts as cut off by the limit.
      a.limited && status !== 'done' ? 1 : 0,
      error,
      f?.text ?? null,
      f?.report ? JSON.stringify(f.report) : null,
      f?.costUsd ?? null,
      f?.tokensIn ?? null,
      f?.tokensOut ?? null,
      Date.now(),
      a.id,
    )
    // When the CLI gave its own result the error is already in the stream; otherwise say why it ended.
    if (error && (!f || a.fatal || r.stop_requested)) this.storeEvents(a.id, [{ kind: 'error', parent: null, data: { message: error } }])
    this.keepAwake()
    this.publish(a.id, true)
  }

  private publish(id: string, finished = false): void {
    const v = this.view(id)
    if (!v) return
    this.bus.emit('run', v)
    if (finished) this.bus.emit('finished', v)
  }

  /** Hold a no-idle-sleep assertion while anything is running, tied to this daemon's lifetime. */
  private keepAwake(): void {
    if (!this.home.config.keepAwake || process.platform !== 'darwin') return
    if (this.active.size > 0 && !this.awake) {
      try {
        this.awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
        this.awake.once('exit', () => {
          this.awake = null
        })
        this.awake.once('error', () => {
          this.awake = null
        })
      } catch {
        this.awake = null
      }
    } else if (this.active.size === 0 && this.awake) {
      this.awake.kill()
      this.awake = null
    }
  }
}
