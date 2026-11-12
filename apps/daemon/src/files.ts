// Files people attach to tasks, comments and messages. Each is kept once under the data folder, in a
// folder of its own so it keeps its real name for the worker that opens it. Nothing here is ever
// run or sent anywhere: the dashboard shows pictures as pictures and hands everything else back as
// a download.
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileView } from '@heybotos/protocol'
import type { Db } from './db.ts'
import type { Home } from './home.ts'

interface FileRow {
  id: string
  name: string
  mime: string
  size: number
  path: string
  created_by: string
  created_at: number
}

export type OwnerKind = 'task' | 'comment' | 'message'

/** The only kinds the dashboard shows in place. Never SVG or HTML: those can carry scripts. */
const PICTURES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' }

/** A name that is safe as a single file name, and still the one the person gave it. */
export function safeName(name: string): string {
  const base = name
    .normalize('NFC')
    .replace(/[\\/]/g, ' ')
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '')
    .replace(/(^|\s)\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  const ext = extname(base).length <= 16 ? extname(base) : ''
  const stem = ext ? base.slice(0, -ext.length) : base
  return `${stem.slice(0, 120 - ext.length)}${ext}`.trim() || 'file'
}

export function sizeWords(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export class Files {
  private home: Home
  private db: Db
  /** The largest file taken, in bytes. */
  maxBytes = 200 * 1024 * 1024

  constructor(home: Home, db: Db) {
    this.home = home
    this.db = db
    mkdirSync(home.files, { recursive: true })
  }

  view(r: FileRow): FileView {
    return { id: r.id, name: r.name, mime: r.mime, size: r.size, image: extname(r.name).toLowerCase() in PICTURES, path: r.path, createdAt: r.created_at }
  }

  row(id: string): FileRow | undefined {
    return this.db.get<FileRow>('select * from files where id = ?', id)
  }

  /** How the dashboard may get it back: the type to answer with, and whether it may be shown in place. */
  serving(r: FileRow): { type: string; inline: boolean } {
    const picture = PICTURES[extname(r.name).toLowerCase()]
    return picture ? { type: picture, inline: true } : { type: 'application/octet-stream', inline: false }
  }

  /** Write an upload to disk as it arrives. Stops, and leaves nothing behind, when it grows past the limit. */
  async save(name: string, mime: string, body: ReadableStream<Uint8Array> | null, createdBy = 'user'): Promise<FileView> {
    if (!body) throw new Error('The file arrived empty.')
    const id = `f_${randomBytes(6).toString('hex')}`
    const dir = join(this.home.files, id)
    mkdirSync(dir, { recursive: true })
    const clean = safeName(name)
    const path = join(dir, clean)
    // Written piece by piece as it arrives, so a large file never sits in memory.
    const out = await open(path, 'wx', 0o600)
    let size = 0
    try {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error(`That file is larger than ${sizeWords(this.maxBytes)}, the most HeyBotOS takes.`)
        }
        await out.write(value)
      }
    } catch (e) {
      await out.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    await out.close()
    if (size === 0) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error('The file arrived empty.')
    }
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime.toLowerCase() : 'application/octet-stream'
    this.db.run('insert into files (id, name, mime, size, path, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)', id, clean, type, size, path, createdBy, Date.now())
    return this.view(this.row(id)!)
  }

  /** Take a file id, or the path a worker or the manager was given for it. */
  resolve(ref: string): FileRow | undefined {
    const id = /(?:^|\/)(f_[0-9a-f]{12})(?:\/|$)/.exec(ref.trim())?.[1]
    return id ? this.row(id) : undefined
  }

  /** Hang files on a task, a comment or a message. Unknown ids are an error, so nothing is lost silently. */
  attach(refs: string[], kind: OwnerKind, ownerId: string): FileView[] {
    const rows = [...new Set(refs)].map((ref) => {
      const r = this.resolve(ref)
      if (!r) throw new Error(`There is no uploaded file "${ref}".`)
      return r
    })
    const now = Date.now()
    for (const r of rows) this.db.run('insert or ignore into file_links (file_id, owner_kind, owner_id, created_at) values (?, ?, ?, ?)', r.id, kind, ownerId, now)
    return rows.map((r) => this.view(r))
  }

  of(kind: OwnerKind, ownerId: string, since = 0): FileView[] {
    return this.db
      .all<FileRow>(
        'select f.* from files f join file_links l on l.file_id = f.id where l.owner_kind = ? and l.owner_id = ? and l.created_at > ? order by l.created_at, f.name',
        kind,
        ownerId,
        since,
      )
      .map((r) => this.view(r))
  }

  count(kind: OwnerKind, ownerId: string): number {
    return this.db.get<{ n: number }>('select count(*) as n from file_links where owner_kind = ? and owner_id = ?', kind, ownerId)?.n ?? 0
  }

  /** Take a file off one thing. The file itself goes when nothing else holds it. */
  detach(id: string, kind: OwnerKind, ownerId: string): void {
    this.db.run('delete from file_links where file_id = ? and owner_kind = ? and owner_id = ?', id, kind, ownerId)
    this.dropIfLoose(id)
  }

  detachAll(kind: OwnerKind, ownerId: string): void {
    const ids = this.db.all<{ file_id: string }>('select file_id from file_links where owner_kind = ? and owner_id = ?', kind, ownerId)
    this.db.run('delete from file_links where owner_kind = ? and owner_id = ?', kind, ownerId)
    for (const { file_id } of ids) this.dropIfLoose(file_id)
  }

  private dropIfLoose(id: string): void {
    if (this.db.get('select 1 from file_links where file_id = ? limit 1', id)) return
    this.drop(id)
  }

  private drop(id: string): void {
    this.db.run('delete from files where id = ?', id)
    rmSync(join(this.home.files, id), { recursive: true, force: true })
  }

  /** Uploads that were never attached to anything (a dialog closed half-way) go after a day. */
  sweep(olderThanMs = 24 * 3600_000): number {
    const loose = this.db.all<{ id: string }>('select id from files where created_at < ? and id not in (select file_id from file_links)', Date.now() - olderThanMs)
    for (const { id } of loose) this.drop(id)
    return loose.length
  }

  /** One line per file for a worker's or the manager's instructions. */
  lines(files: FileView[]): string[] {
    return files.filter((f) => existsSync(f.path) && statSync(f.path).isFile()).map((f) => `- ${f.path} (${f.image ? 'picture' : f.mime}, ${sizeWords(f.size)})`)
  }
}
