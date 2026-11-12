// The team. Every worker task is done by a named member: a specialist with a role, a way of
// working the owner can shape, and notes of their own that grow from task to task.
import type { Engine, StaffView, TaskKind } from '@heybotos/protocol'
import type { Db } from './db.ts'
import type { Manager } from './manager.ts'

export interface StaffRow {
  id: string
  name: string
  title: string
  focus: string
  engine: 'auto' | Engine
  model: string
  effort: string
  persona: string
  memory: string
  hue: number
  active: number
  created_at: number
}

const KINDS: TaskKind[] = ['build', 'review', 'research', 'write', 'ops', 'other']
const MEMORY_LIMIT = 6000

const FOUNDERS: Array<Pick<StaffRow, 'id' | 'name' | 'title' | 'engine' | 'persona' | 'hue'> & { focus: TaskKind[] }> = [
  {
    id: 'ada',
    name: 'Ada',
    title: 'Engineer',
    focus: ['build', 'other'],
    engine: 'auto',
    hue: 222,
    persona: 'You build and fix. You read the code around a change before you touch it, keep the change as small as the task allows, and prove it works by running it. You say plainly what you did not test.',
  },
  {
    id: 'rex',
    name: 'Rex',
    title: 'Reviewer',
    focus: ['review'],
    engine: 'auto',
    hue: 12,
    persona: 'You are the second pair of eyes. You assume the work has a flaw and go looking for it: wrong behaviour first, then risk, then anything that will hurt later. You report what you verified yourself, not what the author claimed.',
  },
  {
    id: 'iris',
    name: 'Iris',
    title: 'Researcher',
    focus: ['research'],
    engine: 'auto',
    hue: 168,
    persona: 'You find things out. You go to primary sources, keep track of where each fact came from, and separate what you confirmed from what you inferred. You answer the question that was asked before anything else.',
  },
  {
    id: 'wren',
    name: 'Wren',
    title: 'Writer',
    focus: ['write'],
    engine: 'auto',
    hue: 290,
    persona: 'You write and edit. You write for one specific reader, say the thing directly, and cut what does not help them. You match the voice of what is already there.',
  },
  {
    id: 'otto',
    name: 'Otto',
    title: 'Operator',
    focus: ['ops'],
    engine: 'auto',
    hue: 44,
    persona: 'You run and operate things. You check the state of a system before you change it, change one thing at a time, and confirm the result. Anything that reaches production or other people waits for the owner.',
  },
]

export function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'member'
  )
}

export class Staff {
  private db: Db
  private manager: Manager

  constructor(db: Db, manager: Manager) {
    this.db = db
    this.manager = manager
    // A team to start with; the owner renames, reshapes, adds and retires members as they like.
    if (!db.get('select id from staff limit 1')) {
      const now = Date.now()
      for (const f of FOUNDERS) {
        db.run('insert into staff (id, name, title, focus, engine, persona, hue, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', f.id, f.name, f.title, JSON.stringify(f.focus), f.engine, f.persona, f.hue, now)
      }
    }
  }

  row(id: string): StaffRow | undefined {
    return this.db.get<StaffRow>('select * from staff where id = ?', id)
  }

  /** By id or by name, as a person or the manager would write it. */
  find(ref: string): StaffRow | undefined {
    const r = ref.trim()
    return this.row(r) ?? this.db.get<StaffRow>('select * from staff where lower(name) = lower(?)', r) ?? this.db.get<StaffRow>('select * from staff where lower(title) = lower(?) and active = 1', r) ?? this.row(slug(r))
  }

  /** Who takes this kind of work when nobody is named. */
  forKind(kind: TaskKind): StaffRow | undefined {
    const active = this.db.all<StaffRow>('select * from staff where active = 1 order by created_at, rowid')
    return active.find((s) => (JSON.parse(s.focus) as string[]).includes(kind)) ?? active.find((s) => (JSON.parse(s.focus) as string[]).includes('other')) ?? active[0]
  }

  private view(s: StaffRow): StaffView {
    const n = (where: string) => this.db.get<{ n: number }>(`select count(*) as n from tasks where assignee = ? and ${where}`, s.id)?.n ?? 0
    const last = this.db.get<{ t: number | null }>('select max(updated_at) as t from tasks where assignee = ?', s.id)?.t ?? null
    const current = this.db.get<{ id: string }>(`select id from tasks where assignee = ? and status = 'running' order by updated_at desc limit 1`, s.id)?.id ?? null
    return {
      id: s.id,
      name: s.name,
      title: s.title,
      focus: JSON.parse(s.focus) as TaskKind[],
      engine: s.engine,
      model: s.model,
      effort: s.effort,
      persona: s.persona,
      memory: s.memory,
      hue: s.hue,
      active: s.active === 1,
      isChief: false,
      stats: { done: n(`status = 'done'`), failed: n(`status = 'failed'`), open: n(`status in ('todo','queued','running','needs_input','blocked')`), lastActiveAt: last },
      currentTaskId: current,
    }
  }

  /** The whole team, led by the manager under whatever name the owner gave it. */
  list(): StaffView[] {
    const chief: StaffView = {
      id: 'chief',
      name: this.manager.name(),
      title: 'Leads the team',
      focus: [],
      engine: 'claude',
      model: '',
      effort: '',
      persona: '',
      memory: '',
      hue: 250,
      active: true,
      isChief: true,
      stats: { done: 0, failed: 0, open: 0, lastActiveAt: null },
      currentTaskId: null,
    }
    return [chief, ...this.db.all<StaffRow>('select * from staff order by active desc, created_at, rowid').map((s) => this.view(s))]
  }

  get(id: string): StaffView | undefined {
    if (id === 'chief') return this.list()[0]
    const s = this.row(id)
    return s ? this.view(s) : undefined
  }

  /** Add a member, or change one. Only the fields given are changed. */
  save(input: { id?: string; name?: string; title?: string; focus?: string[]; engine?: string; model?: string; effort?: string; persona?: string; memory?: string; hue?: number; active?: boolean }): StaffView {
    if (input.id === 'chief') {
      if (typeof input.name === 'string') this.manager.rename(input.name)
      return this.get('chief')!
    }
    const existing = input.id ? this.row(input.id) : undefined
    if (input.id && !existing) throw new Error(`No team member with id "${input.id}".`)
    const name = (input.name ?? existing?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const title = (input.title ?? existing?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!name) throw new Error('A team member needs a name.')
    if (!title) throw new Error('A team member needs a role, like "Engineer" or "Designer".')
    const clash = this.db.get<{ id: string }>('select id from staff where lower(name) = lower(?) and id != ?', name, existing?.id ?? '')
    if (clash) throw new Error(`There is already a team member called "${name}".`)
    const focus = (input.focus ?? (existing ? (JSON.parse(existing.focus) as string[]) : [])).filter((k): k is TaskKind => KINDS.includes(k as TaskKind))
    const engine = input.engine === 'claude' || input.engine === 'codex' || input.engine === 'grok' || input.engine === 'auto' ? input.engine : (existing?.engine ?? 'auto')
    const hue = Number.isFinite(input.hue) ? Math.abs(Math.round(input.hue!)) % 360 : (existing?.hue ?? [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7))
    const fields = [name, title, JSON.stringify(focus), engine, (input.model ?? existing?.model ?? '').trim(), (input.effort ?? existing?.effort ?? '').trim(), (input.persona ?? existing?.persona ?? '').slice(0, 4000), (input.memory ?? existing?.memory ?? '').slice(0, MEMORY_LIMIT), hue, (input.active ?? (existing ? existing.active === 1 : true)) ? 1 : 0] as const
    let id = existing?.id
    if (id) {
      this.db.run('update staff set name = ?, title = ?, focus = ?, engine = ?, model = ?, effort = ?, persona = ?, memory = ?, hue = ?, active = ? where id = ?', ...fields, id)
    } else {
      id = slug(name)
      for (let i = 2; this.row(id) || id === 'chief'; i++) id = `${slug(name)}-${i}`
      this.db.run('insert into staff (name, title, focus, engine, model, effort, persona, memory, hue, active, id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...fields, id, Date.now())
    }
    return this.get(id)!
  }

  /** A member notes something for themselves at the end of a task. The oldest notes fall away when it gets long. */
  remember(id: string, note: string, project: string): void {
    const s = this.row(id)
    const clean = note.replace(/\s+/g, ' ').trim()
    if (!s || !clean) return
    const line = `- ${new Date().toISOString().slice(0, 10)} (${project}): ${clean.slice(0, 500)}`
    let memory = s.memory ? `${s.memory.trimEnd()}\n${line}` : line
    while (memory.length > MEMORY_LIMIT && memory.includes('\n')) memory = memory.slice(memory.indexOf('\n') + 1)
    this.db.run('update staff set memory = ? where id = ?', memory, id)
  }

  /** What a member is told about themselves at the start of a task. */
  instructions(id: string): string {
    const s = this.row(id)
    if (!s) return ''
    const lines = [`You are ${s.name}, the team's ${s.title}. ${this.manager.name()} leads the team and handed you this task; the owner reads your report.`]
    if (s.persona.trim()) lines.push('', s.persona.trim())
    if (s.memory.trim()) lines.push('', 'Your own notes from earlier tasks (newest last):', s.memory.trim())
    return lines.join('\n')
  }
}
