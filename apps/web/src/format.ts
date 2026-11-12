import type { RunStatus, RunView } from '@heybotos/protocol'
import type { Job, JobState } from './store'

export const STATUS_WORDS: Record<RunStatus, string> = {
  queued: 'Waiting for a slot',
  starting: 'Starting',
  running: 'Working',
  stopping: 'Stopping',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Cut off',
  cancelled: 'Stopped',
}

export type Tone = 'signal' | 'ok' | 'wait' | 'bad' | 'muted'
export const STATUS_TONE: Record<RunStatus, Tone> = {
  queued: 'muted',
  starting: 'signal',
  running: 'signal',
  stopping: 'wait',
  waiting: 'wait',
  done: 'ok',
  failed: 'bad',
  interrupted: 'bad',
  cancelled: 'muted',
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** How long a run has been going, or how long it took. */
export function elapsed(r: RunView, now: number): string {
  const from = r.startedAt ?? r.createdAt
  return duration((r.endedAt ?? now) - from)
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const today = new Date(now)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  const y = new Date(now - 86_400_000)
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

/** The last one or two parts of a path: enough to recognise a project folder. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export function tokens(n: number | null): string {
  if (n === null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', grok: 'Grok' } as const


export const JOB_WORDS: Record<JobState, string> = {
  working: 'Working',
  waiting: 'Waiting',
  'needs-you': 'Needs you',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  'not-started': 'Not started',
}

export const JOB_TONE: Record<JobState, Tone> = {
  working: 'signal',
  waiting: 'muted',
  'needs-you': 'wait',
  blocked: 'wait',
  done: 'ok',
  failed: 'bad',
  stopped: 'muted',
  'not-started': 'muted',
}

export function ago(ts: number | null, now: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d} days ago`
  const mo = Math.round(d / 30.4)
  if (mo < 18) return `${mo} months ago`
  return `${Math.round(d / 365)} years ago`
}

/** One line on what a job is doing, wants, or how it ended. */
export function jobLine(job: Job): string {
  const { task, run, state: s } = job
  if (s === 'working') return run?.activity ?? 'Starting'
  if (s === 'waiting') return task?.waitReason ?? 'Waiting for a free worker slot'
  if (s === 'needs-you') return task?.question ?? run?.report?.question ?? 'Waiting for your answer'
  if (s === 'not-started') return 'Not started yet'
  if (s === 'done' || s === 'blocked') return task?.summary ?? run?.report?.summary ?? run?.resultText ?? JOB_WORDS[s]
  if (s === 'stopped') return 'You stopped it'
  return task?.summary ?? run?.error ?? 'Failed'
}
