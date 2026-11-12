// Shared shapes between the daemon and the dashboard. Types only: nothing here exists at runtime.

export type Engine = 'claude' | 'codex' | 'grok'

/** One run is one CLI process, i.e. one turn of an agent session. */
export type RunStatus =
  | 'queued' // waiting for a free slot
  | 'starting' // process spawned, nothing read yet
  | 'running'
  | 'stopping' // stop requested, signals escalating
  | 'waiting' // turn ended on a deferred tool call or a question; resumable
  | 'done'
  | 'failed'
  | 'interrupted' // process died without a result line
  | 'cancelled'

/** The one vocabulary both engines are normalised to. */
export type EventKind =
  | 'phase'
  | 'text'
  | 'thinking'
  | 'tool_start'
  | 'tool_result'
  | 'subagent'
  | 'usage'
  | 'limit'
  | 'error'
  | 'result'

export interface NormEvent {
  kind: EventKind
  /** tool_use id of the sub-agent call this event happened inside, if any. */
  parent: string | null
  data: Record<string, unknown>
}

export interface StoredEvent extends NormEvent {
  id: number
  runId: string
  ts: number
}

/** Token-level streaming. Fanned out live, never stored. */
export interface LiveDelta {
  runId: string
  parent: string | null
  channel: 'text' | 'thinking'
  text: string
}

export interface WorkerReport {
  status: 'done' | 'needs_input' | 'blocked' | 'failed'
  summary: string
  /** One lasting thing worth remembering for next time; kept in the team member's own memory. */
  note_to_self?: string
  files_changed?: string[]
  verification?: string
  question?: string
  follow_ups?: string[]
}

export interface RunView {
  id: string
  taskId: string | null
  engine: Engine
  role: string | null
  title: string
  prompt: string
  cwd: string
  sessionId: string | null
  turn: number
  status: RunStatus
  model: string | null
  activity: string | null
  error: string | null
  resultText: string | null
  report: WorkerReport | null
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  /** True when this turn was cut off because the engine's usage limit ran out. */
  limited: boolean
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

export type TaskStatus = 'todo' | 'queued' | 'running' | 'needs_input' | 'blocked' | 'done' | 'failed' | 'cancelled'
export type TaskKind = 'build' | 'review' | 'research' | 'write' | 'ops' | 'other'
/**
 * Where a task stands, as the board shows it. backlog = written down, no worker; next = started and
 * waiting (for a worker, another task or a usage limit); doing = a worker is on it; needs_you =
 * it stopped to ask, is blocked or failed; done = finished or closed.
 */
export type TaskStage = 'backlog' | 'next' | 'doing' | 'needs_you' | 'done'
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'
/** An epic holds other tasks and is never worked on itself. */
export type TaskTier = 'task' | 'epic'

export interface ProjectView {
  slug: string
  name: string
  path: string
  /** code = found in a projects folder; other = a non-code project with its own workspace. */
  kind: 'code' | 'other'
  description: string
  stack: string
  isGit: boolean
  /** For a linked git worktree: the project it belongs to. */
  parentSlug: string | null
  lastCommitAt: number | null
  dirty: boolean
  hasInstructions: boolean
  missing: boolean
  notes: string
  openTasks: number
  /** The short name in front of every task number here, like BOT in BOT-12. */
  key: string
  starred: boolean
  /** How many tasks stand at each stage. */
  stages: Record<TaskStage, number>
  /** The latest change to any task here. */
  lastTaskAt: number | null
}

export interface TaskView {
  id: string
  project: string
  projectName: string
  parentId: string | null
  title: string
  brief: string
  kind: TaskKind
  status: TaskStatus
  /** Why a queued task has not started yet, in plain words. */
  waitReason: string | null
  engine: Engine
  role: string | null
  dependsOn: string[]
  /** direct = in the project folder; worktree = its own branch and folder. */
  isolation: 'direct' | 'worktree'
  cwd: string
  /** A model and effort chosen for this task; empty means the member's or the engine's default. */
  model: string
  effort: string
  /** The team member doing it. */
  assignee: string | null
  assigneeName: string | null
  /** Connectors (MCP servers) this task's worker may use. With any, it works without a shell. */
  connectors: string[]
  /** True once a snapshot of the folder was taken, so changes can be shown and undone. */
  hasBaseline: boolean
  question: string | null
  summary: string | null
  lastRunId: string | null
  createdBy: 'user' | 'manager'
  createdAt: number
  updatedAt: number
  /** The name people use for it: the project's key and a running number, like BOT-12. */
  key: string
  number: number
  stage: TaskStage
  tier: TaskTier
  priority: TaskPriority
  labels: string[]
  dueAt: number | null
  /** Its place among the others at the same stage; lower comes first. */
  rank: number
  /** Who closed it by hand, when nobody's report did. */
  closedBy: string | null
  counts: { comments: number; files: number; children: number; childrenDone: number }
}

/** A task as another task refers to it. */
export interface TaskRef {
  id: string
  key: string
  title: string
  status: TaskStatus
  stage: TaskStage
}

/** A file somebody attached to a task, a comment or a message. */
export interface FileView {
  id: string
  name: string
  mime: string
  size: number
  /** True when it can be shown as a picture. */
  image: boolean
  /** Where a worker opens it. */
  path: string
  createdAt: number
}

export interface CommentView {
  id: number
  taskId: string
  /** "user", "manager", or a team member's id. */
  author: string
  authorName: string
  text: string
  files: FileView[]
  /** True when it was also sent to the worker as a message. */
  sent: boolean
  createdAt: number
  editedAt: number | null
}

export type LinkType = 'relates' | 'duplicates'

export interface LinkView {
  id: number
  type: LinkType
  /** False when the link was made from the other task ("is duplicated by"). */
  outward: boolean
  task: TaskRef
}

export interface HistoryEntry {
  id: number
  at: number
  actor: string
  actorName: string
  /** What changed: created, status, title, description, priority, labels, due, assignee, … */
  what: string
  from: string | null
  to: string | null
}

/** Everything the task page shows. */
export interface TaskDetail {
  task: TaskView
  runs: RunView[]
  comments: CommentView[]
  files: FileView[]
  links: LinkView[]
  blockedBy: TaskRef[]
  blocks: TaskRef[]
  parent: TaskRef | null
  children: TaskView[]
  history: HistoryEntry[]
}

export interface SavedFilter {
  id: number
  name: string
  /** The address query of the list it brings back, like "stage=needs_you&project=shop". */
  query: string
  createdAt: number
}

/** What can be changed on a task after it was made. Only the fields sent are touched. */
export interface UpdateTaskInput {
  title?: string
  brief?: string
  kind?: TaskKind
  priority?: TaskPriority
  labels?: string[]
  dueAt?: number | null
  /** A team member's id or name; null = whoever takes that kind of work. */
  assignee?: string | null
  /** "auto" lets HeyBotOS choose again. */
  engine?: Engine | 'auto'
  model?: string
  effort?: string
  /** Another task's id or key; null takes it out from under its parent. */
  parentId?: string | null
  dependsOn?: string[]
  connectors?: string[]
}

export interface CreateTaskInput {
  project: string
  title?: string
  brief: string
  kind?: TaskKind
  engine?: Engine
  role?: string
  parentId?: string
  dependsOn?: string[]
  isolation?: 'direct' | 'worktree'
  /** Team member id or name; left out, the task goes to whoever takes that kind of work. */
  assignee?: string
  model?: string
  effort?: string
  connectors?: string[]
  /** Start right away (default) or leave it in the backlog. */
  start?: boolean
  tier?: TaskTier
  priority?: TaskPriority
  labels?: string[]
  dueAt?: number | null
  /** Ids of uploaded files to attach. */
  files?: string[]
}

export interface FileChange {
  path: string
  status: 'added' | 'changed' | 'deleted'
  added: number
  removed: number
}

export interface TaskChanges {
  available: boolean
  /** Why there is nothing to show, when available is false. */
  reason: string | null
  files: FileChange[]
  patch: string
  patchClipped: boolean
}

export interface CreateRunInput {
  engine: Engine
  cwd: string
  prompt: string
  title?: string
  role?: string
  model?: string
  effort?: string
  taskId?: string
}

export interface EngineHealth {
  engine: Engine
  found: boolean
  bin: string | null
  version: string | null
  loggedIn: boolean
  detail: string
}

/** Something a worker wanted to do that needs the owner's yes or no. */
export interface ApprovalView {
  id: string
  runId: string
  taskId: string | null
  /** host = reach a server; tool = an outward-facing connector call; command = a deploy or publish command. */
  kind: 'host' | 'tool' | 'command'
  /** One plain sentence: what it wants to do. */
  summary: string
  /** The exact command or call. */
  detail: string
  title: string
  projectName: string | null
  status: 'pending' | 'approved' | 'denied'
  note: string | null
  createdAt: number
  decidedAt: number | null
}

export interface ChatMessage {
  id: number
  /** user = you; manager = the manager agent; note = something HeyBotOS itself reports in the conversation. */
  role: 'user' | 'manager' | 'note'
  text: string
  runId: string | null
  /** The conversation it belongs to: "chief" for the general one, otherwise a project. */
  thread: string
  createdAt: number
  files: FileView[]
}

export interface ChatState {
  messages: ChatMessage[]
  /** The manager turn in progress, if any; its live stream is /api/runs/<id>/stream. */
  activeRunId: string | null
  /** Which conversation that turn is answering in. */
  activeThread: string | null
  /** Reports gathered for the manager's next turn. */
  waitingReports: number
}

export interface EngineUsage {
  engine: Engine
  /** Installed and signed in with a subscription. */
  ready: boolean
  /** Epoch ms until which no new work is started on this engine, or null. */
  coolingUntil: number | null
  /** Latest reading per limit window, as the CLI reported it. Only Claude reports these. */
  windows: Array<{ window: string; utilization: number | null; resetsAt: number | null; status: string; at: number }>
  /** New workers are held back at or above this share of a window (0–1). */
  headroom: number
  runsToday: number
  tokensOutToday: number
  workingNow: number
}

export interface RoutingView {
  /** balanced = any engine with room takes the next task; rules = each kind of work has its engine. */
  mode: 'balanced' | 'rules'
  pool: Engine[]
  byKind: Record<TaskKind, Engine>
  fallback: boolean
  file: string
}

/** Something the manager does by itself on a schedule. */
export interface RoutineView {
  id: string
  title: string
  /** Five-field cron expression in local time. */
  schedule: string
  /** The schedule in words. */
  when: string
  prompt: string
  enabled: boolean
  createdBy: 'user' | 'manager'
  lastFiredAt: number | null
  nextAt: number | null
}

/** A member of the team: a specialist with a role, a way of working, and a memory of their own. */
export interface StaffView {
  id: string
  name: string
  /** Their role, as shown under the name: "Engineer", "Reviewer". */
  title: string
  /** The kinds of work that go to them when nobody is named. */
  focus: TaskKind[]
  /** Which engine they run on; "auto" follows the routing rules. */
  engine: 'auto' | Engine
  model: string
  effort: string
  /** How they work and what they care about, in the owner's words; part of their instructions. */
  persona: string
  /** What they have noted for themselves across tasks. */
  memory: string
  /** Colour of their mark, as a hue 0–359. */
  hue: number
  active: boolean
  /** True for the manager, who leads the team and is not given worker tasks. */
  isChief: boolean
  stats: { done: number; failed: number; open: number; lastActiveAt: number | null }
  /** The task they are on right now, if any. */
  currentTaskId: string | null
}

/** One of HeyBotOS's own connectors, as the app may see it: never its keys. */
export interface ConnectorView {
  name: string
  transport: 'stdio' | 'http'
  /** Where it lives, without anything secret: the site, or the program. */
  where: string
  enabled: boolean
  /** "added here" or where it was brought in from. */
  source: string
  /** Signed in to through the browser. */
  signedIn: boolean
  /** It turned HeyBotOS away: the owner should sign in to it (or give it a header). */
  needsSignIn: boolean
  /** Names of the tools it offered when last asked. */
  tools: string[]
  /** Those of its tools that change something, so they wait for the owner's yes. */
  asks: string[]
  /** Why it could not be reached when last asked, or null. */
  error: string | null
  checkedAt: number | null
}

/** Everything the owner can change about how HeyBotOS runs, in one object. */
export interface SettingsView {
  general: { maxWorkers: number; notifications: boolean; projectRoots: string[] }
  manager: { name: string; model: string; effort: string; batchSeconds: number }
  engines: Record<Engine, { model: string; effort: string }>
  routing: { mode: 'balanced' | 'rules'; pool: Engine[]; byKind: Record<TaskKind, Engine>; fallback: boolean; headroom: Record<Engine, number> }
  gate: { allowedHosts: string[]; alwaysAllowTools: string[]; askCommandPatterns: string[]; hostGrantMinutes: number; sshAgent: boolean; knownServers: string[] }
  connectors: string[]
  paths: { home: string; config: string }
}

/** A change to the settings: only the parts given are changed. */
export type SettingsPatch = { [K in keyof Omit<SettingsView, 'connectors' | 'paths'>]?: Partial<SettingsView[K]> }

/** One conversation in the sidebar: the general one with the manager, or one per project. */
export interface ThreadView {
  /** "chief", or the project's id. */
  id: string
  name: string
  kind: 'chief' | 'code' | 'other'
  /** The latest thing said or done there, in one line. */
  lastText: string
  lastAt: number
  /** Replies and finished work since the owner last looked. */
  unread: number
  working: number
  needsYou: number
  /** Team members working there now. */
  workers: string[]
}

/** What one engine offers on the owner's plan. */
export interface EngineModels {
  models: Array<{ id: string; name: string }>
  efforts: string[]
  defaultModel: string | null
}
