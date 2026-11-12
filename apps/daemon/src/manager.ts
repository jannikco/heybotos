// The manager agent: one long conversation with the owner, held as a Claude session that is resumed
// turn by turn. Everything that should reach it (the owner's messages, workers' reports) goes
// through one inbox and is delivered in order, one turn at a time.
//
// The daemon keeps the manager cheap: task state lives in the database and is handed over as a short
// status at the start of each turn; reports are gathered so a burst of finishing workers is one turn,
// not twenty; the owner's own messages never wait.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChatMessage, ChatState, RunView, TaskStatus, TaskView } from '@heybotos/protocol'
import type { Bus } from './bus.ts'
import type { Db } from './db.ts'
import type { Home } from './home.ts'
import type { Registry } from './registry.ts'
import type { Tasks } from './tasks.ts'
import type { RunExtra, RunRow, Supervisor } from './engines/supervisor.ts'

interface InboxRow {
  id: number
  kind: 'user' | 'report' | 'routine'
  text: string
  task_id: string | null
  created_at: number
  delivered_run_id: string | null
  thread: string
}

interface MessageRow {
  id: number
  role: ChatMessage['role']
  text: string
  run_id: string | null
  thread: string
  created_at: number
}

const PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts', 'manager.md'), 'utf8')
const SETTLED: TaskStatus[] = ['done', 'needs_input', 'blocked', 'failed']
const LIVE = ['queued', 'starting', 'running', 'stopping']
const QUIET = '(nothing to report)'
/** Built-in tools the manager keeps: enough to understand a request, nothing that changes anything. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']

export class Manager {
  private home: Home
  private db: Db
  private bus: Bus
  private supervisor: Supervisor
  private tasks: Tasks
  private registry: Registry
  private timer: NodeJS.Timeout | null = null
  /** Last status seen per task, to notice the moment one settles. */
  private seen = new Map<string, TaskStatus>()
  /** Where the manager's CLI reaches the daemon. */
  url: string

  constructor(home: Home, db: Db, bus: Bus, supervisor: Supervisor, tasks: Tasks, registry: Registry) {
    this.home = home
    this.db = db
    this.bus = bus
    this.supervisor = supervisor
    this.tasks = tasks
    this.registry = registry
    this.url = `http://127.0.0.1:${home.config.port}`
    for (const t of tasks.list()) this.seen.set(t.id, t.status)
    bus.on('task', (t) => this.onTask(t))
    bus.on('finished', (run) => this.onFinished(run))
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (e) {
        console.error('[manager] tick failed:', e)
      }
    }, 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ── who the manager is to the owner ──────────────────────────────────────────────────────

  /** The name the owner gave it (default "Manager"). Shown across the dashboard and used by the agent itself. */
  name(): string {
    return this.db.get<{ value: string }>(`select value from meta where key = 'manager_name'`)?.value || 'Manager'
  }

  rename(name: string): string {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!clean) throw new Error('Give a name of at least one character.')
    this.db.run(`insert into meta (key, value) values ('manager_name', ?) on conflict(key) do update set value = excluded.value`, clean)
    this.bus.emit('identity', { managerName: clean })
    return clean
  }

  /**
   * Whether the owner has been through the welcome. An installation that already has something in
   * it (a message, a task) never shows one.
   */
  welcomed(): boolean {
    return this.db.get(`select 1 from meta where key = 'welcomed'`) !== undefined || this.db.get('select 1 from messages limit 1') !== undefined || this.db.get('select 1 from tasks limit 1') !== undefined
  }

  setWelcomed(): void {
    this.db.run(`insert into meta (key, value) values ('welcomed', ?) on conflict(key) do update set value = excluded.value`, String(Date.now()))
  }

  // ── access for the manager's own tool server ─────────────────────────────────────────────

  token(): string {
    return createHmac('sha256', this.home.secret).update('mcp:manager').digest('hex')
  }

  verify(token: string): boolean {
    const want = Buffer.from(this.token())
    const got = Buffer.from(token)
    return want.length === got.length && timingSafeEqual(want, got)
  }

  // ── the conversation ─────────────────────────────────────────────────────────────────────

  private toMessage(m: MessageRow): ChatMessage {
    return { id: m.id, role: m.role, text: m.text, runId: m.run_id, thread: m.thread, createdAt: m.created_at, files: this.tasks.files.of('message', String(m.id)) }
  }

  private activeRun(): RunRow | undefined {
    return this.db.get<RunRow>(`select * from runs where role = 'manager' and status in ('queued','starting','running','stopping') order by created_at desc limit 1`)
  }

  private lastRun(): RunRow | undefined {
    return this.db.get<RunRow>(`select * from runs where role = 'manager' order by created_at desc, rowid desc limit 1`)
  }

  private waiting(): InboxRow[] {
    return this.db.all<InboxRow>('select * from manager_inbox where delivered_run_id is null order by id')
  }

  /** Which conversation a manager turn is answering in. */
  private threadOf(runId: string | undefined): string | null {
    if (!runId) return null
    return this.db.get<{ thread: string }>('select thread from manager_inbox where delivered_run_id = ? limit 1', runId)?.thread ?? 'chief'
  }

  /** One conversation: the general one ("chief") or a project's. Without a thread: everything, oldest first. */
  state(thread?: string): ChatState {
    const rows = thread
      ? this.db.all<MessageRow>('select * from (select * from messages where thread = ? order by id desc limit 300) order by id', thread)
      : this.db.all<MessageRow>('select * from (select * from messages order by id desc limit 300) order by id')
    const active = this.activeRun()
    return { messages: rows.map((m) => this.toMessage(m)), activeRunId: active?.id ?? null, activeThread: this.threadOf(active?.id), waitingReports: this.waiting().filter((i) => i.kind === 'report').length }
  }

  private publish(message: ChatMessage | null = null): void {
    const active = this.activeRun()
    this.bus.emit('chat', { message, activeRunId: active?.id ?? null, activeThread: this.threadOf(active?.id), waitingReports: this.waiting().filter((i) => i.kind === 'report').length })
  }

  private addMessage(role: ChatMessage['role'], text: string, runId: string | null = null, thread = 'chief', files: string[] = []): ChatMessage {
    const lastId = this.db.tx(() => {
      const made = this.db.run('insert into messages (role, text, run_id, thread, created_at) values (?, ?, ?, ?, ?)', role, text, runId, thread, Date.now()).lastId
      if (files.length) this.tasks.files.attach(files, 'message', String(made))
      return made
    })
    const m = this.toMessage(this.db.get<MessageRow>('select * from messages where id = ?', lastId)!)
    this.publish(m)
    return m
  }

  /** The owner says something, in the general conversation or in a project's. */
  say(text: string, thread = 'chief', files: string[] = []): ChatMessage {
    const clean = text.trim()
    if (!clean && !files.length) throw new Error('Write a message first.')
    if (thread !== 'chief' && !this.registry.row(thread)) throw new Error('That conversation does not exist.')
    const m = this.addMessage('user', clean, null, thread, files)
    // The manager reads attached files itself, and can put them on a task by these paths.
    const attached = this.tasks.files.lines(m.files)
    const heard = [clean, attached.length ? `[The owner attached ${attached.length === 1 ? 'a file' : `${attached.length} files`}. Read what you need; to give one to a worker, pass its path in "files" when you create the task.]\n${attached.join('\n')}` : ''].filter(Boolean).join('\n\n')
    this.db.run(`insert into manager_inbox (kind, text, thread, created_at) values ('user', ?, ?, ?)`, heard, thread, Date.now())
    this.tick()
    return m
  }

  /** A routine came due: its instructions reach the manager as if the owner had just asked. */
  routine(title: string, prompt: string): void {
    this.addMessage('note', `The routine "${title}" came due. The manager is on it.`)
    this.db.run(`insert into manager_inbox (kind, text, created_at) values ('routine', ?, ?)`, `${title}\n${prompt}`, Date.now())
    this.tick()
  }

  /** Stop the manager's current turn. */
  interrupt(): void {
    const run = this.activeRun()
    if (run) this.supervisor.stop(run.id)
  }

  // ── what wakes the manager ───────────────────────────────────────────────────────────────

  private onTask(t: TaskView): void {
    const before = this.seen.get(t.id)
    this.seen.set(t.id, t.status)
    // Only the tasks the manager itself handed out report back to it; the rest are the owner's own.
    if (t.createdBy !== 'manager' || before === t.status || !SETTLED.includes(t.status)) return
    // A worker waiting for a yes in the owner's inbox is not something the manager can act on.
    if (t.status === 'needs_input' && this.db.get(`select id from approvals where task_id = ? and status = 'pending'`, t.id)) return
    // Closed by the manager's own hand: it knows.
    if (t.closedBy === 'manager') return
    const what = t.closedBy
      ? `was closed by the owner by hand${t.status === 'cancelled' ? ', as not to be done' : ''}.`
      : t.status === 'done'
        ? `is done. Its report: ${t.summary ?? '(no summary)'}`
        : t.status === 'needs_input'
          ? `stopped to ask: ${t.question ?? t.summary ?? '(no question given)'}`
          : t.status === 'blocked'
            ? `is blocked. Its report: ${t.summary ?? '(no summary)'}`
            : `failed. ${t.summary ?? ''}`
    // A report belongs to its project's conversation; that is where the manager answers it.
    this.db.run(`insert into manager_inbox (kind, text, task_id, thread, created_at) values ('report', ?, ?, ?, ?)`, `Task ${t.key} "${t.title}" in ${t.projectName} ${what}`, t.id, t.project, Date.now())
    this.publish()
    this.tick()
  }

  private onFinished(run: RunView): void {
    if (run.role !== 'manager') return
    const text = run.resultText?.trim() ?? ''
    const thread = this.threadOf(run.id) ?? 'chief'
    if (run.status === 'done') {
      if (text && text !== QUIET) this.addMessage('manager', text, run.id, thread)
    } else if (run.status === 'cancelled') {
      this.addMessage('note', 'You stopped the manager before it finished answering.', run.id, thread)
    } else {
      this.addMessage('note', `The manager could not finish its turn: ${run.error ?? 'the session ended without an answer'}\nSend your message again to retry.`, run.id, thread)
    }
    this.publish()
    this.tick()
  }

  /** Decide whether the manager should take a turn now. Public so tests can drive time. */
  tick(now = Date.now()): void {
    if (this.activeRun()) return
    const all = this.waiting()
    if (!all.length) return
    // One turn answers in one conversation. The owner's own words come first; then reports, each
    // in its project's conversation. A turn in the general conversation also carries every waiting
    // report, because that is where the owner asks about everything at once.
    const spoken = all.find((i) => i.kind !== 'report')
    const thread = (spoken ?? all[0]!).thread
    const items = all.filter((i) => i.thread === thread || (thread === 'chief' && spoken !== undefined && i.kind === 'report'))
    if (!spoken) {
      const cfg = this.home.config.manager
      // Reports only: gather them while other handed-out tasks are still working, up to a limit.
      const stillWorking = this.db.get(`select id from tasks where created_by = 'manager' and status in ('queued','running') limit 1`) !== undefined
      if (stillWorking && now - items[0]!.created_at < cfg.batchSeconds * 1000) return
      const turns = this.db.get<{ n: number }>(`select count(*) as n from runs where role = 'manager' and created_at > ?`, now - 3600_000)?.n ?? 0
      if (turns >= cfg.maxTurnsPerHour) return
    }
    this.takeTurn(items, thread)
  }

  // ── a turn ───────────────────────────────────────────────────────────────────────────────

  /** The task list as it stands, short enough to lead every turn. */
  status(): string {
    const open = this.tasks.list({ open: true }, 200)
    const count = (s: TaskStatus) => open.filter((t) => t.status === s).length
    const approvals = this.db.get<{ n: number }>(`select count(*) as n from approvals where status = 'pending'`)?.n ?? 0
    const time = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    const lines = [`[HeyBotOS status, ${time}]`, `The owner calls you: ${this.name()}.`]
    if (!open.length) lines.push('No open tasks.')
    else {
      lines.push(`Open tasks: ${count('running')} working, ${count('queued')} waiting to start, ${count('needs_input')} waiting for an answer, ${count('blocked')} blocked, ${count('todo')} in the backlog (not started).`)
      for (const t of open.slice(0, 20)) lines.push(`- ${t.key} [${t.status === 'todo' ? 'backlog' : t.status}] ${t.projectName}: ${t.title}${t.waitReason ? ` (${t.waitReason})` : ''}`)
      if (open.length > 20) lines.push(`- and ${open.length - 20} more (list_tasks shows them)`)
    }
    if (approvals) lines.push(`${approvals} request${approvals === 1 ? '' : 's'} for approval ${approvals === 1 ? 'is' : 'are'} waiting in the owner's inbox; only they can decide those.`)
    return lines.join('\n')
  }

  private systemPrompt(): string {
    const notesPath = join(this.home.manager, 'owner-notes.md')
    const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : ''
    const parts = [PROMPT.trim(), '', `The owner's projects live in: ${this.home.config.projectRoots.join(', ')}. ${this.registry.list().filter((p) => !p.parentSlug && !p.missing).length} projects are known.`]
    if (notes) parts.push('', 'Your notes about the owner from earlier sessions:', notes)
    return parts.join('\n')
  }

  private takeTurn(items: InboxRow[], thread: string): void {
    const reports = items.filter((i) => i.kind === 'report')
    const said = items.filter((i) => i.kind === 'user')
    const project = thread === 'chief' ? undefined : this.registry.row(thread)
    const where = project
      ? `[This turn is in the conversation for the project "${project.name}" (id ${project.slug}, folder ${project.path}). What the owner says here is about this project unless they say otherwise; your reply is shown there.]`
      : '[This turn is in the general conversation: anything, across all projects.]'
    const parts = [this.status(), where]
    if (reports.length) parts.push(['[Reports from workers since your last turn]', ...reports.map((r) => `- ${r.text}`)].join('\n'))
    for (const r of items.filter((i) => i.kind === 'routine')) {
      const [title, ...rest] = r.text.split('\n')
      parts.push(`[A routine the owner set up has come due: ${title}]\n${rest.join('\n')}`)
    }
    if (said.length) parts.push(`[The owner says]\n${said.map((s) => s.text).join('\n\n')}`)
    else if (!items.some((i) => i.kind === 'routine')) parts.push(`[No message from the owner. Decide what the reports call for. Reply only if there is something they should know; otherwise reply with exactly: ${QUIET}]`)

    const cfg = this.home.config.manager
    const last = this.lastRun()
    const resumable = last && last.session_id && !LIVE.includes(last.status) && last.status !== 'interrupted' && last.turn < cfg.rotateAfterTurns
    let run: RunView
    try {
      if (resumable) {
        run = this.supervisor.continue(last.id, parts.join('\n\n'))
      } else {
        // A fresh session: it has the task list above, its notes, and the tail of the conversation.
        const recent = this.db.all<MessageRow>(`select * from (select * from messages where role != 'note' and thread = ? order by id desc limit 10) order by id`, thread)
        const tail = said.length ? recent.slice(0, -said.length) : recent
        if (tail.length) parts.splice(2, 0, ['[The conversation so far, most recent last]', ...tail.map((m) => `${m.role === 'user' ? 'Owner' : 'You'}: ${m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text}`)].join('\n'))
        const extra: RunExtra = {
          systemPrompt: this.systemPrompt(),
          tools: READ_ONLY_TOOLS,
          mcpConfig: { mcpServers: { heybotos: { type: 'http', url: `${this.url}/mcp`, headers: { Authorization: `Bearer ${this.token()}` } } } },
        }
        run = this.supervisor.create({
          engine: 'claude',
          cwd: this.home.manager,
          prompt: parts.join('\n\n'),
          title: 'Manager',
          role: 'manager',
          model: cfg.model || undefined,
          effort: cfg.effort || undefined,
          lockKey: 'manager',
          extra,
        })
      }
    } catch (e) {
      this.addMessage('note', `The manager could not be started: ${(e as Error).message}`, null, thread)
      return
    }
    this.db.run(`update manager_inbox set delivered_run_id = ? where id in (${items.map(() => '?').join(',')})`, run.id, ...items.map((i) => i.id))
    this.publish()
  }
}
