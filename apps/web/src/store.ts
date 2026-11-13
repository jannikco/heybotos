// One small reactive store. The overview stream keeps the run list and activity strips current.
import { computed, reactive } from 'vue'
import type { ApprovalView, ChatMessage, ChatState, Engine, EngineHealth, EngineModels, ProjectView, RunStatus, RunView, StaffView, TaskView, ThreadView, UpdateState } from '@heybotos/protocol'
import { api } from './api'

export type TickKind = 'tool' | 'handoff' | 'say' | 'error'
/** [seconds since the run started, kind] */
export type Tick = [number, TickKind]

export const state = reactive({
  signedIn: null as boolean | null,
  reachable: true,
  live: false,
  me: null as { version: string; stage: string | null; home: string; maxWorkers: number; managerName: string; welcomed: boolean } | null,
  runs: [] as RunView[],
  tasks: [] as TaskView[],
  chat: { messages: [] as ChatMessage[], activeRunId: null as string | null, activeThread: null as string | null, waitingReports: 0, loaded: false },
  /** Messages per conversation, for the ones that have been opened. */
  talk: {} as Record<string, ChatMessage[]>,
  threads: [] as ThreadView[],
  staff: [] as StaffView[],
  /** Requests waiting for a yes or no. */
  approvals: [] as ApprovalView[],
  projects: [] as ProjectView[],
  projectsLoaded: false,
  pulse: {} as Record<string, Tick[]>,
  health: null as EngineHealth[] | null,
  /** Whether there is a newer version, and how far fetching it is. */
  update: null as UpdateState | null,
  command: { name: '', n: 0 },
  models: null as Record<Engine, EngineModels> | null,
  now: Date.now(),
})

setInterval(() => (state.now = Date.now()), 1000)

const WORKING: RunStatus[] = ['starting', 'running', 'stopping']
export const isWorking = (s: RunStatus) => WORKING.includes(s)
export const isLive = (s: RunStatus) => s === 'queued' || isWorking(s)

/** One line in the Agents list: a task (with its latest turn), or a stand-alone agent session. */
export type JobState = 'working' | 'waiting' | 'needs-you' | 'blocked' | 'done' | 'failed' | 'stopped' | 'not-started'
export interface Job {
  key: string
  /** What the panel opens: the latest run, or the task when it has not run yet. */
  openId: string
  title: string
  run: RunView | null
  task: TaskView | null
  state: JobState
  at: number
}

function runState(r: RunView): JobState {
  if (isWorking(r.status)) return 'working'
  if (r.status === 'queued') return 'waiting'
  if (r.status === 'waiting') return 'needs-you'
  if (r.status === 'done') return 'done'
  if (r.status === 'cancelled') return 'stopped'
  return 'failed'
}

function taskState(t: TaskView, r: RunView | null): JobState {
  if (r && isWorking(r.status)) return 'working'
  switch (t.status) {
    case 'running':
      return 'working'
    case 'queued':
      return 'waiting'
    case 'needs_input':
      return 'needs-you'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    case 'cancelled':
      return 'stopped'
    case 'todo':
      return 'not-started'
    default:
      return 'failed'
  }
}

export const jobs = computed<Job[]>(() => {
  const latest = new Map<string, RunView>()
  for (const r of state.runs) {
    // The manager's own turns are the conversation, not a worker.
    if (r.role === 'manager') continue
    const key = r.taskId ?? r.sessionId ?? r.id
    const seen = latest.get(key)
    if (!seen || r.createdAt > seen.createdAt || (r.createdAt === seen.createdAt && r.turn > seen.turn)) latest.set(key, r)
  }
  const out: Job[] = []
  const tasks = new Map(state.tasks.map((t) => [t.id, t]))
  for (const t of state.tasks) {
    const r = latest.get(t.id) ?? null
    out.push({ key: t.id, openId: r?.id ?? t.id, title: t.title, run: r, task: t, state: taskState(t, r), at: r?.endedAt ?? r?.createdAt ?? t.updatedAt })
  }
  for (const [key, r] of latest) {
    if (r.taskId && tasks.has(r.taskId)) continue
    out.push({ key, openId: r.id, title: r.title, run: r, task: null, state: runState(r), at: r.endedAt ?? r.createdAt })
  }
  return out.sort((a, b) => b.at - a.at)
})

/** Tasks that stopped to ask something, not counting those already covered by a request card. */
export const questions = computed(() => {
  const withRequest = new Set(state.approvals.map((a) => a.taskId))
  return state.tasks.filter((t) => (t.status === 'needs_input' || t.status === 'blocked') && !withRequest.has(t.id))
})
export const inboxCount = computed(() => state.approvals.length + questions.value.length)

export const working = computed(() => jobs.value.filter((j) => j.state === 'working'))
export const queued = computed(() => jobs.value.filter((j) => j.state === 'waiting'))
export const needsYou = computed(() => jobs.value.filter((j) => j.state === 'needs-you' || j.state === 'blocked'))

function upsertTask(task: TaskView): void {
  const i = state.tasks.findIndex((t) => t.id === task.id)
  if (i >= 0) state.tasks[i] = task
  else state.tasks.unshift(task)
}

/** The sidebar's conversations and the team change with almost everything; refetch shortly after any change. */
let refreshTimer = 0
function refreshSoon(): void {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    void loadThreads().catch(() => {})
    void loadStaff().catch(() => {})
  }, 250)
}

export async function loadThreads(): Promise<void> {
  state.threads = (await api<{ threads: ThreadView[] }>('/api/threads')).threads
}

export async function loadStaff(): Promise<void> {
  state.staff = (await api<{ staff: StaffView[] }>('/api/staff')).staff
}

/** How many messages the stream has brought per conversation, so a load that was on its way can tell it is out of date. */
const arrived: Record<string, number> = {}

/** Open a conversation: load what was said there, and keep it current from the stream. */
export async function loadTalk(thread: string): Promise<void> {
  const before = arrived[thread] ?? 0
  const c = await api<ChatState>(`/api/chat?thread=${encodeURIComponent(thread)}`)
  // Something was said there while this was on its way, and what came back may not have it: ask again.
  if ((arrived[thread] ?? 0) !== before) return loadTalk(thread)
  state.talk[thread] = c.messages
  state.chat.activeRunId = c.activeRunId
  state.chat.activeThread = c.activeThread
  state.chat.waitingReports = c.waitingReports
}

export async function markRead(thread: string): Promise<void> {
  const t = state.threads.find((x) => x.id === thread)
  if (t) t.unread = 0
  await api(`/api/threads/${encodeURIComponent(thread)}/read`, { method: 'POST' }).catch(() => {})
}

export async function loadChat(): Promise<void> {
  const c = await api<ChatState>('/api/chat')
  state.chat.messages = c.messages
  state.chat.activeRunId = c.activeRunId
  state.chat.waitingReports = c.waitingReports
  state.chat.loaded = true
}

export async function loadProjects(rescan = false): Promise<void> {
  const res = await api<{ projects: ProjectView[] }>(rescan ? '/api/projects/scan' : '/api/projects', rescan ? { method: 'POST' } : undefined)
  state.projects = res.projects
  state.projectsLoaded = true
}

function upsert(run: RunView): void {
  const i = state.runs.findIndex((r) => r.id === run.id)
  if (i >= 0) state.runs[i] = run
  else state.runs.unshift(run)
}

let source: EventSource | null = null

async function loadPulse(ids: string[]): Promise<void> {
  if (!ids.length) return
  const { pulse } = await api<{ pulse: Record<string, Tick[]> }>(`/api/pulse?ids=${ids.join(',')}`)
  Object.assign(state.pulse, pulse)
}

function connect(): void {
  source?.close()
  source = new EventSource('/api/stream')
  source.addEventListener('hello', (e) => {
    state.live = true
    const hello = JSON.parse((e as MessageEvent).data) as { runs: RunView[]; tasks: TaskView[]; approvals: ApprovalView[] }
    state.runs = hello.runs
    state.tasks = hello.tasks
    state.approvals = hello.approvals
    if (state.chat.loaded) void loadChat().catch(() => {})
    for (const thread of Object.keys(state.talk)) void loadTalk(thread).catch(() => {})
    refreshSoon()
    void loadPulse(state.runs.slice(0, 60).map((r) => r.id)).catch(() => {})
  })
  source.addEventListener('run', (e) => upsert(JSON.parse((e as MessageEvent).data) as RunView))
  source.addEventListener('task', (e) => {
    upsertTask(JSON.parse((e as MessageEvent).data) as TaskView)
    refreshSoon()
  })
  source.addEventListener('task-removed', (e) => {
    const { id } = JSON.parse((e as MessageEvent).data) as { id: string }
    state.tasks = state.tasks.filter((t) => t.id !== id)
    refreshSoon()
  })
  source.addEventListener('approval', (e) => {
    const a = JSON.parse((e as MessageEvent).data) as ApprovalView
    state.approvals = state.approvals.filter((x) => x.id !== a.id)
    if (a.status === 'pending') state.approvals.unshift(a)
  })
  source.addEventListener('update', (e) => {
    state.update = JSON.parse((e as MessageEvent).data) as UpdateState
  })
  source.addEventListener('identity', (e) => {
    if (state.me) state.me.managerName = (JSON.parse((e as MessageEvent).data) as { managerName: string }).managerName
  })
  source.addEventListener('chat', (e) => {
    const c = JSON.parse((e as MessageEvent).data) as { message: ChatMessage | null; activeRunId: string | null; activeThread: string | null; waitingReports: number }
    if (c.message) {
      arrived[c.message.thread] = (arrived[c.message.thread] ?? 0) + 1
      const list = state.talk[c.message.thread]
      if (list && !list.some((m) => m.id === c.message!.id)) list.push(c.message)
      if (!state.chat.messages.some((m) => m.id === c.message!.id)) state.chat.messages.push(c.message)
    }
    state.chat.activeRunId = c.activeRunId
    state.chat.activeThread = c.activeThread
    state.chat.waitingReports = c.waitingReports
    refreshSoon()
  })
  source.addEventListener('tick', (e) => {
    const t = JSON.parse((e as MessageEvent).data) as { runId: string; ts: number; kind: TickKind }
    const run = state.runs.find((r) => r.id === t.runId)
    if (!run) return
    ;(state.pulse[t.runId] ??= []).push([(t.ts - (run.startedAt ?? run.createdAt)) / 1000, t.kind])
  })
  source.onerror = () => {
    // EventSource retries by itself; check whether the reason is a lost session.
    state.live = false
    void api('/api/me').catch(() => {})
  }
}

export async function boot(): Promise<void> {
  try {
    state.me = await api('/api/me')
    state.signedIn = true
    connect()
    void refreshHealth()
    void loadProjects().catch(() => {})
    void loadChat().catch(() => {})
    void loadThreads().catch(() => {})
    void loadStaff().catch(() => {})
    void api<UpdateState>('/api/update')
      .then((u) => (state.update = u))
      .catch(() => {})
  } catch {
    /* api() has already recorded why */
  }
}

export async function refreshHealth(fresh = false): Promise<void> {
  state.health = (await api<{ engines: EngineHealth[] }>(`/api/health${fresh ? '?fresh=1' : ''}`)).engines
}

export const taskById = (id: string | null | undefined) => (id ? state.tasks.find((t) => t.id === id) : undefined)

/** What the owner calls the manager. */
export const managerName = computed(() => state.me?.managerName || 'Manager')

/** One-shot commands from menus and shortcuts ("palette", "new-task", "focus"); views watch `state.command`. */
export function command(name: string): void {
  state.command = { name, n: state.command.n + 1 }
}

/** A stable colour for anything with a name: a project, a conversation. */
export function hueOf(key: string): number {
  let h = 7
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export const staffById = (id: string | null | undefined) => (id ? state.staff.find((s) => s.id === id) : undefined)
