// The conversations in the sidebar: the general one with the manager, and one per project that has
// anything going on. A conversation is "unread" when the manager has answered or work has settled
// there since the owner last looked.
import type { ThreadView } from '@heybotos/protocol'
import type { Db } from './db.ts'
import type { Registry } from './registry.ts'

export class Threads {
  private db: Db
  private registry: Registry

  constructor(db: Db, registry: Registry) {
    this.db = db
    this.registry = registry
  }

  private readAt(thread: string): number {
    return this.db.get<{ read_at: number }>('select read_at from thread_reads where thread = ?', thread)?.read_at ?? 0
  }

  markRead(thread: string, at = Date.now()): void {
    this.db.run('insert into thread_reads (thread, read_at) values (?, ?) on conflict(thread) do update set read_at = excluded.read_at', thread, at)
  }

  private one(id: string, name: string, kind: ThreadView['kind']): ThreadView | null {
    const read = this.readAt(id)
    const msg = this.db.get<{ text: string; created_at: number; role: string }>('select text, created_at, role from messages where thread = ? order by id desc limit 1', id)
    const unreadMessages = this.db.get<{ n: number }>(`select count(*) as n from messages where thread = ? and role != 'user' and created_at > ?`, id, read)?.n ?? 0
    let lastText = msg ? `${msg.role === 'user' ? 'You: ' : ''}${msg.text}` : ''
    let lastAt = msg?.created_at ?? 0
    let unread = unreadMessages
    let working = 0
    let needsYou = 0
    let workers: string[] = []
    if (id !== 'chief') {
      const task = this.db.get<{ title: string; status: string; summary: string | null; question: string | null; updated_at: number }>('select title, status, summary, question, updated_at from tasks where project_slug = ? order by updated_at desc limit 1', id)
      if (task && task.updated_at > lastAt) {
        lastAt = task.updated_at
        lastText = task.status === 'needs_input' ? `Asks: ${task.question ?? task.title}` : task.status === 'done' ? (task.summary ?? `Done: ${task.title}`) : task.status === 'failed' ? `Failed: ${task.title}` : task.status === 'blocked' ? `Blocked: ${task.title}` : task.title
      }
      unread += this.db.get<{ n: number }>(`select count(*) as n from tasks where project_slug = ? and status in ('done','needs_input','blocked','failed') and updated_at > ?`, id, read)?.n ?? 0
      working = this.db.get<{ n: number }>(`select count(*) as n from tasks where project_slug = ? and status = 'running'`, id)?.n ?? 0
      needsYou = this.db.get<{ n: number }>(`select count(*) as n from tasks where project_slug = ? and status in ('needs_input','blocked')`, id)?.n ?? 0
      workers = this.db.all<{ assignee: string }>(`select distinct assignee from tasks where project_slug = ? and status = 'running' and assignee is not null`, id).map((r) => r.assignee)
      if (!lastAt) return null // a project nobody has talked about or worked in is not a conversation yet
    }
    return { id, name, kind, lastText: lastText.replace(/\s+/g, ' ').slice(0, 160), lastAt, unread, working, needsYou, workers }
  }

  /** Every conversation with something in it, most recent first; the general one always leads. */
  list(managerName: string): ThreadView[] {
    const chief = this.one('chief', managerName, 'chief')!
    const projects = this.registry
      .list()
      .map((p) => this.one(p.slug, p.name, p.kind))
      .filter((t): t is ThreadView => t !== null)
      .sort((a, b) => b.lastAt - a.lastAt)
    return [chief, ...projects]
  }
}
