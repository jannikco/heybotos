// Routines: things the manager does by itself on a schedule (a morning brief, a nightly check).
// A routine that comes due puts its instructions in the manager's inbox, as if the owner had asked.
import { randomBytes } from 'node:crypto'
import type { RoutineView } from '@heybotos/protocol'
import type { Db } from './db.ts'
import type { Manager } from './manager.ts'

interface RoutineRow {
  id: string
  title: string
  schedule: string
  prompt: string
  enabled: number
  created_by: 'user' | 'manager'
  created_at: number
  last_fired_at: number | null
  next_at: number | null
}

export interface Cron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Day-of-month and day-of-week both restricted: either may match, as in standard cron. */
  either: boolean
}

const FIELDS: Array<[keyof Omit<Cron, 'either'>, number, number, string]> = [
  ['minute', 0, 59, 'minute'],
  ['hour', 0, 23, 'hour'],
  ['dom', 1, 31, 'day of the month'],
  ['month', 1, 12, 'month'],
  ['dow', 0, 7, 'day of the week'],
]

function field(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!m) throw new Error(`The ${name} part "${part}" is not something a schedule understands.`)
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) throw new Error(`The step in "${part}" must be at least 1.`)
    let [from, to] = m[1] === '*' ? [min, max] : (m[1]!.split('-').map(Number) as [number, number?]).map((n) => n as number)
    if (to === undefined) to = m[2] ? max : from
    if (from! < min || to! > max || from! > to!) throw new Error(`The ${name} must be between ${min} and ${max}; "${part}" is not.`)
    for (let n = from!; n <= to!; n += step) out.add(n)
  }
  return out
}

/** Parse a five-field cron expression: minute hour day-of-month month day-of-week. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A schedule has five parts: minute, hour, day of the month, month, day of the week. For example "30 7 * * 1-5" is weekdays at 07:30.')
  const c = { either: parts[2] !== '*' && parts[4] !== '*' } as Cron
  FIELDS.forEach(([key, min, max, name], i) => {
    c[key] = field(parts[i]!, min, max, name)
  })
  if (c.dow.has(7)) c.dow.add(0) // both 0 and 7 mean Sunday
  return c
}

/** The first time after `from` (epoch ms, local time) that the schedule matches. */
export function nextAfter(c: Cron, from: number): number {
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  // Step by day until the date matches, then find the time within it. At most a few years of days.
  for (let guard = 0; guard < 366 * 5; guard++) {
    const domOk = c.dom.has(d.getDate())
    const dowOk = c.dow.has(d.getDay())
    const dayOk = c.month.has(d.getMonth() + 1) && (c.either ? domOk || dowOk : domOk && dowOk)
    if (dayOk) {
      for (let h = d.getHours(); h < 24; h++) {
        if (!c.hour.has(h)) continue
        for (let m = h === d.getHours() ? d.getMinutes() : 0; m < 60; m++) {
          if (c.minute.has(m)) {
            const hit = new Date(d)
            hit.setHours(h, m, 0, 0)
            return hit.getTime()
          }
        }
      }
    }
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
  }
  throw new Error('That schedule never comes due.')
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

/** The schedule in words, for the common shapes; the expression itself for the rest. */
export function describeSchedule(expr: string): string {
  const [min = '', hour = '', dom = '', month = '', dow = ''] = expr.trim().split(/\s+/)
  const at = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` : null
  if (dom === '*' && month === '*') {
    if (at && dow === '*') return `Every day at ${at}`
    if (at && dow === '1-5') return `Weekdays at ${at}`
    if (at && (dow === '0,6' || dow === '6,0' || dow === '6,7')) return `Weekends at ${at}`
    if (at && /^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${at}`
    if (/^\d+$/.test(min) && hour === '*' && dow === '*') return min === '0' ? 'Every hour, on the hour' : `Every hour at ${min} minutes past`
    if (/^\*\/\d+$/.test(min) && hour === '*' && dow === '*') return `Every ${min.slice(2)} minutes`
  }
  if (at && /^\d+$/.test(dom) && month === '*' && dow === '*') return `On day ${dom} of every month at ${at}`
  return `On the schedule ${expr.trim()}`
}

export class Routines {
  private db: Db
  private manager: Manager
  private timer: NodeJS.Timeout | null = null

  constructor(db: Db, manager: Manager) {
    this.db = db
    this.manager = manager
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (e) {
        console.error('[routines] tick failed:', e)
      }
    }, 20_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private view(r: RoutineRow): RoutineView {
    return { id: r.id, title: r.title, schedule: r.schedule, when: describeSchedule(r.schedule), prompt: r.prompt, enabled: r.enabled === 1, createdBy: r.created_by, lastFiredAt: r.last_fired_at, nextAt: r.enabled === 1 ? r.next_at : null }
  }

  private row(id: string): RoutineRow {
    const r = this.db.get<RoutineRow>('select * from routines where id = ?', id)
    if (!r) throw new Error(`No routine with id "${id}".`)
    return r
  }

  list(): RoutineView[] {
    return this.db.all<RoutineRow>('select * from routines order by created_at').map((r) => this.view(r))
  }

  create(input: { title: string; schedule: string; prompt: string }, createdBy: 'user' | 'manager' = 'user', now = Date.now()): RoutineView {
    const title = input.title?.trim()
    const prompt = input.prompt?.trim()
    if (!title) throw new Error('Give the routine a name.')
    if (!prompt) throw new Error('Say what the manager should do when the routine comes due.')
    const cron = parseCron(input.schedule ?? '')
    const id = `rt_${randomBytes(4).toString('hex')}`
    this.db.run('insert into routines (id, title, schedule, prompt, created_by, created_at, next_at) values (?, ?, ?, ?, ?, ?, ?)', id, title, input.schedule.trim().replace(/\s+/g, ' '), prompt, createdBy, now, nextAfter(cron, now))
    return this.view(this.row(id))
  }

  remove(id: string): void {
    this.row(id)
    this.db.run('delete from routines where id = ?', id)
  }

  setEnabled(id: string, enabled: boolean, now = Date.now()): RoutineView {
    const r = this.row(id)
    // Turning one back on never fires for the time it was off.
    this.db.run('update routines set enabled = ?, next_at = ? where id = ?', enabled ? 1 : 0, enabled ? nextAfter(parseCron(r.schedule), now) : r.next_at, id)
    return this.view(this.row(id))
  }

  runNow(id: string, now = Date.now()): RoutineView {
    const r = this.row(id)
    this.fire(r, now, false)
    return this.view(this.row(id))
  }

  private fire(r: RoutineRow, now: number, reschedule = true): void {
    this.manager.routine(r.title, r.prompt)
    this.db.run('update routines set last_fired_at = ?, next_at = ? where id = ?', now, reschedule ? nextAfter(parseCron(r.schedule), now) : r.next_at, r.id)
  }

  /**
   * Fire what is due. One routine per tick, so several that came due while the Mac slept start a
   * little apart; and a routine that missed many occurrences fires once, not once per miss.
   */
  tick(now = Date.now()): number {
    const due = this.db.get<RoutineRow>('select * from routines where enabled = 1 and next_at is not null and next_at <= ? order by next_at limit 1', now)
    if (!due) return 0
    this.fire(due, now)
    return 1
  }
}
