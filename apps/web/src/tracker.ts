// What the tracker's pages share: the stages of the board, the words and tones for them, the
// filters (kept in the address, so a view can be linked), uploads, and the calls that change a task.
import { computed, reactive, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import type { FileView, SavedFilter, TaskPriority, TaskStage, TaskStatus, TaskView, UpdateTaskInput } from '@heybotos/protocol'
import { api, ApiError } from './api'
import type { Tone } from './format'
import { state } from './store'

export const STAGES: Array<{ id: TaskStage; title: string; hint: string; tone: Tone }> = [
  { id: 'backlog', title: 'Backlog', hint: 'Written down, no worker on it', tone: 'muted' },
  { id: 'next', title: 'Up next', hint: 'Started; waiting for a worker or another task', tone: 'muted' },
  { id: 'doing', title: 'In progress', hint: 'A worker is on it', tone: 'signal' },
  { id: 'needs_you', title: 'Needs you', hint: 'Stopped to ask, blocked or failed', tone: 'wait' },
  { id: 'done', title: 'Done', hint: 'Finished or closed', tone: 'ok' },
]
export const STAGE_TITLE = Object.fromEntries(STAGES.map((s) => [s.id, s.title])) as Record<TaskStage, string>

/** The word on a task's status pill: its stage, except where the exact state says more. */
export function statusWord(t: Pick<TaskView, 'status' | 'stage'>): string {
  if (t.status === 'failed') return 'Failed'
  if (t.status === 'blocked') return 'Blocked'
  if (t.status === 'cancelled') return 'Closed'
  return STAGE_TITLE[t.stage]
}
export function statusTone(t: Pick<TaskView, 'status' | 'stage'>): Tone {
  if (t.status === 'failed') return 'bad'
  if (t.status === 'cancelled') return 'muted'
  return STAGES.find((s) => s.id === t.stage)!.tone
}
export const TONE_VAR: Record<Tone, string> = { signal: 'var(--signal)', ok: 'var(--ok)', wait: 'var(--wait)', bad: 'var(--bad)', muted: 'var(--ink-3)' }

export const PRIORITIES: Array<{ id: TaskPriority; title: string }> = [
  { id: 'urgent', title: 'Urgent' },
  { id: 'high', title: 'High' },
  { id: 'normal', title: 'Normal' },
  { id: 'low', title: 'Low' },
]
export const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const STAGE_RANK: Record<TaskStage, number> = { needs_you: 0, doing: 1, next: 2, backlog: 3, done: 4 }

export const isOpen = (s: TaskStatus) => s !== 'done' && s !== 'cancelled'

/** A due date in a few words, and whether it has passed. */
export function due(at: number | null, now: number, done = false): { words: string; late: boolean; soon: boolean } | null {
  if (at === null) return null
  const day = (ms: number) => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = day(at) - day(now)
  const d = new Date(at)
  const words = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
  return { words, late: !done && diff < 0, soon: !done && diff >= 0 && diff <= 1 }
}

/** A date field's value (YYYY-MM-DD) for a moment, and back. Noon, so no time zone moves the day. */
export const toDateField = (at: number | null) => (at === null ? '' : new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10))
export const fromDateField = (v: string) => (v ? new Date(`${v}T12:00:00`).getTime() : null)

export function sizeWords(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ── filters ──

export interface Filter {
  q: string
  project: string
  stage: string
  assignee: string
  label: string
  priority: string
  /** A parent's key: only what sits under it. */
  under: string
  group: string
  sort: string
  dir: string
  lanes: string
}
const KEYS: Array<keyof Filter> = ['q', 'project', 'stage', 'assignee', 'label', 'priority', 'under', 'group', 'sort', 'dir', 'lanes']
const WHICH: Array<keyof Filter> = ['q', 'project', 'stage', 'assignee', 'label', 'priority', 'under']

function fromQuery(q: LocationQuery): Filter {
  const out = {} as Filter
  for (const k of KEYS) out[k] = typeof q[k] === 'string' ? (q[k] as string) : ''
  return out
}
export const toQuery = (f: Filter): Record<string, string> => Object.fromEntries(KEYS.filter((k) => f[k]).map((k) => [k, f[k]]))

/**
 * The filter of the page, read from and written to the address. `locked` fixes the project (on a
 * project's own page).
 */
export function useFilter(locked?: () => string | undefined): { filter: Filter; active: Ref<boolean>; clear: () => void; hits: Ref<Set<string> | null>; match: (t: TaskView) => boolean } {
  const route = useRoute()
  const router = useRouter()
  const filter = reactive(fromQuery(route.query))
  watch(
    () => route.query,
    (q) => Object.assign(filter, fromQuery(q)),
  )
  watch(
    () => ({ ...filter }),
    (f) => {
      const next = toQuery(f)
      const now = toQuery(fromQuery(route.query))
      if (JSON.stringify(next) !== JSON.stringify(now)) void router.replace({ query: next })
    },
  )
  const active = computed(() => WHICH.some((k) => filter[k] && !(k === 'project' && locked?.())))
  const clear = () => WHICH.forEach((k) => (filter[k] = ''))

  // Words are looked up by the daemon (it also searches comments and file names); the rest is matched here.
  const hits = ref<Set<string> | null>(null)
  let asked = 0
  watch(
    () => filter.q.trim(),
    (q) => {
      const mine = ++asked
      if (!q) return void (hits.value = null)
      window.setTimeout(() => {
        if (mine !== asked) return
        void api<{ tasks: TaskView[] }>(`/api/tasks/search?q=${encodeURIComponent(q)}`)
          .then((r) => mine === asked && (hits.value = new Set(r.tasks.map((t) => t.id))))
          .catch(() => {})
      }, 180)
    },
    { immediate: true },
  )

  const byKey = computed(() => new Map(state.tasks.map((t) => [t.key, t])))
  function match(t: TaskView): boolean {
    const project = locked?.() || filter.project
    if (project && t.project !== project) return false
    if (filter.stage && !filter.stage.split(',').includes(t.stage)) return false
    if (filter.assignee && (filter.assignee === 'none' ? t.assignee !== null : t.assignee !== filter.assignee)) return false
    if (filter.label && !t.labels.includes(filter.label)) return false
    if (filter.priority && t.priority !== filter.priority) return false
    if (filter.under && t.parentId !== byKey.value.get(filter.under)?.id) return false
    const q = filter.q.trim().toLowerCase()
    if (q) {
      if (hits.value) return hits.value.has(t.id)
      // Until the daemon has answered: what can be told from here.
      return q.split(/\s+/).every((w) => `${t.key} ${t.title} ${t.brief} ${t.labels.join(' ')}`.toLowerCase().includes(w))
    }
    return true
  }
  return { filter, active, clear, hits, match }
}

/** The order of a column on the board: by hand for open work, latest first for what is finished. */
export function byRank(a: TaskView, b: TaskView): number {
  return a.rank - b.rank || a.createdAt - b.createdAt
}
export const byUpdated = (a: TaskView, b: TaskView) => b.updatedAt - a.updatedAt

export function sortTasks(list: TaskView[], sort: string, dir: string): TaskView[] {
  const sign = dir === 'desc' ? -1 : 1
  const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  const cmp: Record<string, (a: TaskView, b: TaskView) => number> = {
    key: (a, b) => text(a.project, b.project) || a.number - b.number,
    title: (a, b) => text(a.title, b.title),
    status: (a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage],
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    assignee: (a, b) => text(a.assigneeName ?? '~', b.assigneeName ?? '~'),
    project: (a, b) => text(a.projectName, b.projectName),
    due: (a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity),
    updated: (a, b) => a.updatedAt - b.updatedAt,
    rank: byRank,
  }
  const by = cmp[sort] ?? cmp.updated!
  return [...list].sort((a, b) => sign * by(a, b) || b.updatedAt - a.updatedAt)
}

export const allLabels = computed(() => [...new Set(state.tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b)))
export const epics = computed(() => state.tasks.filter((t) => t.tier === 'epic'))
export const taskByKey = (key: string) => state.tasks.find((t) => t.key.toLowerCase() === key.toLowerCase())

// ── saved filters ──

export const savedFilters = ref<SavedFilter[]>([])
export async function loadFilters(): Promise<void> {
  savedFilters.value = (await api<{ filters: SavedFilter[] }>('/api/filters')).filters
}
export const READY_FILTERS: Array<{ name: string; query: string }> = [
  { name: 'Needs you', query: 'stage=needs_you' },
  { name: 'Open', query: 'stage=backlog,next,doing,needs_you' },
  { name: 'In the backlog', query: 'stage=backlog&sort=rank' },
  { name: 'Done', query: 'stage=done&sort=updated&dir=desc' },
]

// ── changing a task ──

export const patchTask = (id: string, patch: UpdateTaskInput) => api<{ task: TaskView }>(`/api/tasks/${id}`, { method: 'PATCH', body: patch })
export const moveTask = (id: string, to: { stage?: TaskStage; before?: string; after?: string; wontDo?: boolean }) => api<{ task: TaskView }>(`/api/tasks/${id}/move`, { method: 'POST', body: to })

// ── uploads ──

export async function uploadFile(file: File): Promise<FileView> {
  let res: Response
  try {
    res = await fetch(`/api/files?name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' })
  } catch {
    throw new ApiError('The HeyBotOS service is not answering.', 0)
  }
  const data = (await res.json().catch(() => ({}))) as { file?: FileView; error?: string }
  if (!res.ok || !data.file) throw new ApiError(data.error ?? `"${file.name}" could not be uploaded (${res.status}).`, res.status)
  return data.file
}

/** Files waiting to be attached to something that is being written: a new task, a comment, a message. */
export function useUploads() {
  const files = ref<FileView[]>([])
  const busy = ref(0)
  const problem = ref('')
  async function add(list: Iterable<File>): Promise<FileView[]> {
    const added: FileView[] = []
    problem.value = ''
    for (const f of list) {
      busy.value++
      try {
        const up = await uploadFile(f)
        files.value = [...files.value, up]
        added.push(up)
      } catch (e) {
        problem.value = (e as ApiError).message
      } finally {
        busy.value--
      }
    }
    return added
  }
  const remove = (id: string) => (files.value = files.value.filter((f) => f.id !== id))
  const clear = () => (files.value = [])
  /** Paste: a screenshot or copied files become attachments; plain text is left to the field. */
  function onPaste(e: ClipboardEvent): void {
    const pasted = [...(e.clipboardData?.files ?? [])]
    if (!pasted.length) return
    e.preventDefault()
    void add(pasted)
  }
  function onDrop(e: DragEvent): void {
    const dropped = [...(e.dataTransfer?.files ?? [])]
    if (!dropped.length) return
    e.preventDefault()
    void add(dropped)
  }
  return { files, busy, problem, add, remove, clear, onPaste, onDrop, ids: computed(() => files.value.map((f) => f.id)) }
}
