// The gate at work: every shell command and connector call of a worker is checked here (by the
// PreToolUse hook and by the ssh/scp/rsync wrappers). What needs a yes becomes a card in the
// owner's inbox; the worker is told to carry on without it and report that it is waiting; the
// owner's decision resumes the same session.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApprovalView } from '@heybotos/protocol'
import type { Bus } from './bus.ts'
import type { Db } from './db.ts'
import { nodeCommand, type Home } from './home.ts'
import type { Tasks } from './tasks.ts'
import type { RunExtra, RunRow, Supervisor } from './engines/supervisor.ts'
import { decide, type GateConfig } from './policy/gate.ts'

interface ApprovalRow {
  id: string
  run_id: string
  task_id: string | null
  scope: string
  kind: 'host' | 'tool' | 'command'
  fingerprint: string
  summary: string
  detail: string
  status: 'pending' | 'approved' | 'denied'
  note: string | null
  uses_left: number
  expires_at: number | null
  notified: number
  created_at: number
  decided_at: number | null
}

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks')
const SHIMMED = ['ssh', 'scp', 'sftp', 'rsync', 'mosh']
/** The name under which every worker sees the gateway to the owner's connectors. */
export const HUB = 'hub'

const WAIT_MESSAGE = (what: string) =>
  `HeyBotOS: this needs the owner's approval before it can run (${what}). A request is now in their inbox. ` +
  `Do not try to reach the same result another way. Finish whatever else you can, then hand in your report with status needs_input ` +
  `and say what you are waiting for. You will be resumed with their decision.`

export class Approvals {
  private home: Home
  private db: Db
  private bus: Bus
  private supervisor: Supervisor
  private tasks: Tasks
  private shimDir: string
  private zdotDir: string
  cfg: GateConfig
  /** Where workers reach the daemon; set once the port is known. */
  url: string

  constructor(home: Home, db: Db, bus: Bus, supervisor: Supervisor, tasks: Tasks, cfg: GateConfig) {
    this.home = home
    this.db = db
    this.bus = bus
    this.supervisor = supervisor
    this.tasks = tasks
    this.cfg = cfg
    this.url = `http://127.0.0.1:${home.config.port}`
    this.shimDir = join(home.state, 'shims')
    this.zdotDir = join(home.state, 'zdot')
    this.writeShims()
    this.writeShellStartup()
    supervisor.decorate = (run, extra) => this.decorate(run, extra)
    // A worker that was still busy when the owner decided hears about it as soon as its turn ends,
    // however that turn ended: it may have reported "done" having worked around the missing step.
    // Resuming happens after this event has reached everyone: done from inside it, the app would hear
    // "working again" before the "done" that came first, and show the older one last.
    bus.on('task', (t) => {
      if (['needs_input', 'blocked', 'done', 'failed'].includes(t.status)) this.tellSoon(t.id)
    })
    bus.on('finished', (run) => {
      if (!run.taskId && run.status !== 'cancelled') this.tellSoon(run.sessionId ?? run.id)
    })
  }

  // ── wiring into every worker ─────────────────────────────────────────────────────────────

  /** Wrappers named ssh, scp, … that sit first on a worker's PATH and ask the gate before the real program runs. */
  private writeShims(): void {
    mkdirSync(this.shimDir, { recursive: true })
    for (const name of SHIMMED) {
      const path = join(this.shimDir, name)
      writeFileSync(path, `#!/bin/sh\nexec env ${nodeCommand(join(HOOKS, 'gate-shim.mjs'))} ${name} "$@"\n`)
      chmodSync(path, 0o755)
    }
  }

  /**
   * Codex (and many scripts) run commands in a login shell, and a login shell on macOS rebuilds PATH
   * with the system folders first, which would put the real ssh ahead of the wrappers. Workers
   * therefore get their own zsh start-up folder: it loads the owner's usual start-up files and then
   * puts the wrappers back in front.
   */
  private writeShellStartup(): void {
    mkdirSync(this.zdotDir, { recursive: true })
    const front = '[ -n "$HEYBOTOS_SHIM_DIR" ] && export PATH="$HEYBOTOS_SHIM_DIR:$PATH"\n'
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      writeFileSync(join(this.zdotDir, name), `[ -f "$HOME/${name}" ] && . "$HOME/${name}"\n${name === '.zshenv' ? '' : front}`)
    }
  }

  /** A token that lets one run ask the gate about itself, and nothing else. */
  token(runId: string): string {
    return createHmac('sha256', this.home.secret).update(`gate:${runId}`).digest('hex')
  }

  verify(runId: string, token: string): boolean {
    const want = Buffer.from(this.token(runId))
    const got = Buffer.from(token)
    return want.length === got.length && timingSafeEqual(want, got)
  }

  private decorate(run: RunRow, extra: RunExtra): RunExtra {
    const hook = {
      type: 'command',
      command: nodeCommand(join(HOOKS, 'gate-hook.mjs')),
      timeout: 20,
      // If the hook cannot run or answer, the call does not happen.
      onFailure: 'block',
    }
    const settings = { ...(extra.settings ?? {}) } as Record<string, any>
    settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: [...(settings.hooks?.PreToolUse ?? []), { matcher: 'Bash|mcp__.*', hooks: [hook] }] }
    return {
      ...extra,
      settings,
      pathPrefix: [this.shimDir, ...(extra.pathPrefix ?? [])],
      env: {
        ...(extra.env ?? {}),
        HEYBOTOS_GATE_URL: this.url,
        HEYBOTOS_GATE_TOKEN: this.token(run.id),
        HEYBOTOS_SHIM_DIR: this.shimDir,
        ZDOTDIR: this.zdotDir,
        // The owner's SSH agent, so their keys work for the team. The wrappers still decide which servers.
        ...(this.cfg.sshAgent && process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      },
    }
  }

  // ── the check ────────────────────────────────────────────────────────────────────────────

  private view(a: ApprovalRow): ApprovalView {
    const task = a.task_id ? this.tasks.get(a.task_id) : undefined
    const run = this.supervisor.view(a.run_id)
    return {
      id: a.id,
      runId: a.run_id,
      taskId: a.task_id,
      kind: a.kind,
      summary: a.summary,
      detail: a.detail,
      title: task?.title ?? run?.title ?? 'A worker',
      projectName: task?.projectName ?? null,
      status: a.status,
      note: a.note,
      createdAt: a.created_at,
      decidedAt: a.decided_at,
    }
  }

  private row(id: string): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>('select * from approvals where id = ?', id)
  }

  list(status: ApprovalRow['status'] | 'all' = 'pending'): ApprovalView[] {
    const rows =
      status === 'all'
        ? this.db.all<ApprovalRow>('select * from approvals order by created_at desc limit 200')
        : this.db.all<ApprovalRow>('select * from approvals where status = ? order by created_at desc limit 200', status)
    return rows.map((a) => this.view(a))
  }

  /** Called for every gated-kind action of a worker. Returns allow, or deny with what to tell the worker. */
  check(runId: string, tool: string, input: Record<string, unknown>): { decision: 'allow' | 'deny'; reason?: string } {
    const run = this.supervisor.row(runId)
    if (!run) return { decision: 'deny', reason: 'HeyBotOS does not know this worker, so the action was not allowed.' }
    // A call to one of the owner's connectors goes through HeyBotOS's gateway, which asks this same
    // gate under the connector's own name. Asking here as well would file every request twice.
    if (tool.startsWith(`mcp__${HUB}__`)) return { decision: 'allow' }
    const verdict = decide(this.cfg, tool, input)
    if (verdict.decision === 'allow') return { decision: 'allow' }

    // One decision covers a task (all its turns), or a stand-alone agent session.
    const scope = run.task_id ?? run.session_id ?? run.id
    const fingerprint = createHash('sha256').update(`${verdict.kind}\n${verdict.key}`).digest('hex')
    const now = Date.now()
    const known = this.db.all<ApprovalRow>('select * from approvals where scope = ? and fingerprint = ? order by created_at desc', scope, fingerprint)

    const grant = known.find((a) => a.status === 'approved' && ((a.expires_at !== null && a.expires_at > now) || a.uses_left > 0))
    if (grant) {
      if (grant.kind !== 'host') this.db.run('update approvals set uses_left = uses_left - 1 where id = ?', grant.id)
      return { decision: 'allow' }
    }
    const refused = known.find((a) => a.status === 'denied' && a.decided_at !== null && now - a.decided_at < 6 * 3600_000)
    if (refused) {
      return { decision: 'deny', reason: `HeyBotOS: the owner said no to this (${verdict.summary.toLowerCase()})${refused.note ? `: "${refused.note}"` : ''}. Do not try it again or another way; work without it or report why you cannot.` }
    }
    if (!known.some((a) => a.status === 'pending')) {
      const id = `a_${randomBytes(4).toString('hex')}`
      this.db.run(
        `insert into approvals (id, run_id, task_id, scope, kind, fingerprint, summary, detail, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        runId,
        run.task_id,
        scope,
        verdict.kind,
        fingerprint,
        verdict.summary,
        verdict.detail,
        now,
      )
      this.bus.emit('approval', this.view(this.row(id)!))
    }
    return { decision: 'deny', reason: WAIT_MESSAGE(verdict.summary.toLowerCase()) }
  }

  // ── the owner's decision ─────────────────────────────────────────────────────────────────

  /** Called when the owner says "always" for a server, so the allow list can be saved by whoever owns the settings. */
  onAlways: (host: string) => void = (host) => {
    if (!this.cfg.allowedHosts.includes(host)) this.cfg.allowedHosts.push(host)
  }

  decideApproval(id: string, allow: boolean, note = '', always = false): ApprovalView {
    const a = this.row(id)
    if (!a) throw new Error('No such request.')
    if (a.status !== 'pending') throw new Error('That request has already been decided.')
    if (allow && always) {
      if (a.kind !== 'host') throw new Error('Only a server can be allowed for good from here. For connector tools, use Settings.')
      const host = a.summary.replace(/^Connect to the server /, '').trim().toLowerCase()
      this.onAlways(host)
      note = note.trim() ? note : 'From now on this server does not need asking.'
    }
    const now = Date.now()
    this.db.run(
      `update approvals set status = ?, note = ?, decided_at = ?, uses_left = ?, expires_at = ? where id = ?`,
      allow ? 'approved' : 'denied',
      note.trim() || null,
      now,
      // A host stays open for a while (a deploy makes several connections); anything else runs once.
      allow && a.kind !== 'host' ? 1 : 0,
      allow && a.kind === 'host' ? now + this.cfg.hostGrantMinutes * 60_000 : null,
      id,
    )
    const view = this.view(this.row(id)!)
    this.bus.emit('approval', view)
    this.tellScope(a.scope)
    return view
  }

  private tellSoon(scope: string): void {
    setImmediate(() => {
      // The daemon may have shut down in between.
      if (this.db.raw.isOpen) this.tellScope(scope)
    })
  }

  /** Resume the waiting worker with every decision it has not heard yet. Does nothing while it is still working. */
  private tellScope(scope: string): void {
    const news = this.db.all<ApprovalRow>(`select * from approvals where scope = ? and status != 'pending' and notified = 0 order by decided_at`, scope)
    if (!news.length) return
    // Decide once everything asked for has an answer, so the worker is not resumed half-informed.
    if (this.db.get(`select id from approvals where scope = ? and status = 'pending'`, scope)) return
    const lines = news.map((a) =>
      a.status === 'approved'
        ? `- Allowed${a.kind === 'host' ? ` for the next ${this.cfg.hostGrantMinutes} minutes` : ' once'}: ${a.summary}${a.note ? ` (${a.note})` : ''}`
        : `- Not allowed: ${a.summary}${a.note ? ` (${a.note})` : ''}`,
    )
    const message = `The owner has decided:\n${lines.join('\n')}\n\nCarry on from where you stopped. What was allowed will now go through; do not attempt what was not allowed.`
    const first = news[0]!
    try {
      if (first.task_id) {
        const task = this.tasks.get(first.task_id)
        if (!task || task.status === 'running' || task.status === 'queued') return
        this.tasks.answer(first.task_id, message)
      } else {
        const last = this.db.get<RunRow>('select * from runs where session_id = ? or id = ? order by created_at desc, rowid desc limit 1', scope, scope)
        if (!last || ['queued', 'starting', 'running', 'stopping'].includes(last.status)) return
        this.supervisor.continue(last.id, message)
      }
      this.db.run(`update approvals set notified = 1 where scope = ? and status != 'pending'`, scope)
    } catch (e) {
      console.error('[approvals] could not resume the worker:', e)
    }
  }

  /** For the health page: is everything the gate needs in place? */
  ready(): boolean {
    return existsSync(join(HOOKS, 'gate-hook.mjs')) && existsSync(join(this.shimDir, 'ssh'))
  }
}
