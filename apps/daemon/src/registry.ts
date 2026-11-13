// The list of the user's projects: every folder directly inside a projects root, plus non-code
// projects HeyBotOS keeps in its own data folder.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ProjectView, TaskStage } from '@heybotos/protocol'
import type { Db } from './db.ts'
import type { Home } from './home.ts'
import { GIT } from './platform.ts'

interface ProjectRow {
  slug: string
  name: string
  path: string
  kind: 'code' | 'other'
  description: string
  stack: string
  is_git: number
  git_common_dir: string | null
  parent_slug: string | null
  last_commit_at: number | null
  dirty: number
  has_instructions: number
  missing: number
  notes: string
  connectors: string
  created_at: number
  scanned_at: number | null
  key: string | null
  next_number: number
  starred: number
}

/** The board's stages, by the states a task can be in. */
export const STAGE_OF: Record<string, TaskStage> = { todo: 'backlog', queued: 'next', running: 'doing', needs_input: 'needs_you', blocked: 'needs_you', failed: 'needs_you', done: 'done', cancelled: 'done' }

const KEY = /^[A-Z][A-Z0-9]{1,5}$/

/** A key from a project's name: initials when it has three words or more, else its first three characters. */
export function keyFrom(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  let key = words.length >= 3 ? words.map((w) => w[0]).join('').slice(0, 4) : words.join('').slice(0, 3)
  if (!/^[A-Z]/.test(key)) key = `P${key}`.slice(0, 4)
  return key.length >= 2 ? key : `${key}X`.padEnd(2, 'X')
}

const SKIP = new Set(['node_modules'])

function gitOut(dir: string, args: string[], timeout = 10_000): Promise<string | null> {
  return new Promise((done) => {
    execFile(GIT, ['-C', dir, ...args], { windowsHide: true, timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) =>
      done(err ? null : stdout.trim()),
    )
  })
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

/** The first real sentence of a project's own instructions or readme. */
export function describe(dir: string): { text: string; hasInstructions: boolean } {
  const hasInstructions = existsSync(join(dir, 'CLAUDE.md')) || existsSync(join(dir, 'AGENTS.md'))
  for (const file of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'readme.md', 'README']) {
    const p = join(dir, file)
    if (!existsSync(p)) continue
    let text = ''
    try {
      text = readFileSync(p, 'utf8').slice(0, 6000)
    } catch {
      continue
    }
    const paragraphs = text.split(/\n\s*\n/).map((b) => b.trim())
    for (const block of paragraphs) {
      if (!block || /^(#|<|!\[|\[!\[|```|---|\||>|\* \* \*)/.test(block)) continue
      const plain = block
        .replace(/\n/g, ' ')
        .replace(/[*_`]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
      if (plain.length < 20) continue
      return { text: plain.length > 240 ? `${plain.slice(0, 239)}…` : plain, hasInstructions }
    }
  }
  return { text: '', hasInstructions }
}

export function detectStack(dir: string): string {
  const has = (f: string) => existsSync(join(dir, f))
  const parts: string[] = []
  if (has('artisan') && has('composer.json')) parts.push('Laravel')
  else if (has('composer.json')) parts.push('PHP')
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const front = deps.next ? 'Next.js' : deps.nuxt ? 'Nuxt' : deps.electron ? 'Electron' : deps.vue ? 'Vue' : deps.react ? 'React' : deps.svelte ? 'Svelte' : null
      if (front) parts.push(front)
      else if (!parts.length) parts.push('Node')
    } catch {
      if (!parts.length) parts.push('Node')
    }
  }
  if (has('pyproject.toml') || has('requirements.txt')) parts.push('Python')
  if (has('go.mod')) parts.push('Go')
  if (has('Cargo.toml')) parts.push('Rust')
  if (has('wp-config.php') || has('wp-content')) parts.push('WordPress')
  if (!parts.length && has('index.html')) parts.push('Static site')
  return parts.slice(0, 3).join(', ')
}

function expand(root: string): string {
  return root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root
}

export class Registry {
  private home: Home
  private db: Db
  private scanning: Promise<number> | null = null

  constructor(home: Home, db: Db) {
    this.home = home
    this.db = db
    this.giveKeys()
  }

  /** Every project without a key gets one, in a settled order so the same folders always get the same keys. */
  private giveKeys(): void {
    for (const r of this.db.all<{ slug: string }>('select slug from projects where key is null order by slug')) this.giveKey(r.slug)
  }

  private view(r: ProjectRow): ProjectView {
    const stages: Record<TaskStage, number> = { backlog: 0, next: 0, doing: 0, needs_you: 0, done: 0 }
    let open = 0
    let lastTaskAt: number | null = null
    for (const s of this.db.all<{ status: string; n: number; u: number }>(`select status, count(*) as n, max(updated_at) as u from tasks where project_slug = ? and tier = 'task' group by status`, r.slug)) {
      stages[STAGE_OF[s.status] ?? 'backlog'] += s.n
      if (['todo', 'queued', 'running', 'needs_input', 'blocked'].includes(s.status)) open += s.n
      lastTaskAt = Math.max(lastTaskAt ?? 0, s.u)
    }
    return {
      slug: r.slug,
      name: r.name,
      path: r.path,
      kind: r.kind,
      description: r.description,
      stack: r.stack,
      isGit: r.is_git === 1,
      parentSlug: r.parent_slug,
      lastCommitAt: r.last_commit_at,
      dirty: r.dirty === 1,
      hasInstructions: r.has_instructions === 1,
      missing: r.missing === 1,
      notes: r.notes,
      openTasks: open,
      key: r.key ?? this.giveKey(r.slug),
      starred: r.starred === 1,
      connectors: JSON.parse(r.connectors || '[]') as string[],
      stages,
      lastTaskAt,
    }
  }

  /** Every project has a key. One that has none yet (a folder just found) gets it the first time it is shown. */
  private giveKey(slug: string): string {
    const r = this.row(slug)!
    if (r.key) return r.key
    const base = keyFrom(r.name)
    const free = (k: string) => !this.db.get('select 1 from projects where key = ?', k)
    let key = base
    // DES is taken: try DESI from the name, then DES2, DES3, …
    const letters = r.name.toUpperCase().replace(/[^A-Z0-9]/g, '')
    for (let n = base.length + 1; !free(key) && n <= 5 && n <= letters.length && letters.startsWith(base); n++) key = letters.slice(0, n)
    for (let n = 2; !free(key); n++) key = `${base.slice(0, 5 - String(n).length)}${n}`
    this.db.run('update projects set key = ? where slug = ?', key, slug)
    return key
  }

  byKey(key: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>('select * from projects where key = ?', key.toUpperCase())
  }

  /** The next task number in a project. Call inside the transaction that inserts the task. */
  takeNumber(slug: string): number {
    this.giveKey(slug)
    const n = this.row(slug)!.next_number
    this.db.run('update projects set next_number = ? where slug = ?', n + 1, slug)
    return n
  }

  /** Change a project's key, or star it. */
  update(slug: string, patch: { key?: string; starred?: boolean; connectors?: string[] }): ProjectView {
    const r = this.row(slug)
    if (!r) throw new Error('No such project.')
    if (patch.key !== undefined) {
      const key = patch.key.trim().toUpperCase()
      if (!KEY.test(key)) throw new Error('A key is two to six letters and digits, starting with a letter, like BOT or C2P.')
      const taken = this.byKey(key)
      if (taken && taken.slug !== slug) throw new Error(`${key} is already the key of ${taken.name}.`)
      this.db.run('update projects set key = ? where slug = ?', key, slug)
    }
    if (patch.starred !== undefined) this.db.run('update projects set starred = ? where slug = ?', patch.starred ? 1 : 0, slug)
    if (patch.connectors !== undefined) this.db.run('update projects set connectors = ? where slug = ?', JSON.stringify([...new Set(patch.connectors)]), slug)
    return this.get(slug)!
  }

  list(): ProjectView[] {
    return this.db.all<ProjectRow>('select * from projects order by coalesce(last_commit_at, created_at) desc').map((r) => this.view(r))
  }

  row(slug: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>('select * from projects where slug = ?', slug)
  }

  get(slug: string): ProjectView | undefined {
    const r = this.row(slug)
    return r ? this.view(r) : undefined
  }

  /** Find a project by slug, exact name, folder path or key; what a person or the manager would type. */
  find(ref: string): ProjectView | undefined {
    const r =
      this.row(ref) ??
      this.db.get<ProjectRow>('select * from projects where lower(name) = lower(?)', ref) ??
      this.db.get<ProjectRow>('select * from projects where path = ?', ref) ??
      this.row(slugify(ref)) ??
      this.byKey(ref)
    return r ? this.view(r) : undefined
  }

  setNotes(slug: string, notes: string): ProjectView {
    const r = this.row(slug)
    if (!r) throw new Error('No such project.')
    this.db.run('update projects set notes = ? where slug = ?', notes, slug)
    // Non-code projects keep their notes as a file too, where workers can read them.
    if (r.kind === 'other') writeFileSync(join(r.path, 'notes.md'), notes)
    return this.get(slug)!
  }

  private freeSlug(base: string, path: string): string {
    let slug = base
    for (let n = 2; ; n++) {
      const taken = this.row(slug)
      if (!taken || taken.path === path) return slug
      slug = `${base}-${n}`
    }
  }

  /** A project that is not code: research, writing, planning. It gets its own workspace folder. */
  createOther(name: string, description = ''): ProjectView {
    const clean = name.trim()
    if (!clean) throw new Error('Give the project a name.')
    if (this.db.get('select slug from projects where lower(name) = lower(?)', clean)) throw new Error(`There is already a project called "${clean}".`)
    const path = join(this.home.projects, slugify(clean))
    const slug = this.freeSlug(slugify(clean), path)
    mkdirSync(path, { recursive: true })
    if (!existsSync(join(path, 'notes.md'))) writeFileSync(join(path, 'notes.md'), description ? `${description}\n` : '')
    this.db.run(
      `insert into projects (slug, name, path, kind, description, notes, created_at) values (?, ?, ?, 'other', ?, ?, ?)`,
      slug,
      clean,
      path,
      description,
      description,
      Date.now(),
    )
    return this.get(slug)!
  }

  /** Look at every folder in the project roots. Safe to call often: a scan already running is reused. */
  scan(): Promise<number> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  private async doScan(): Promise<number> {
    const dirs: string[] = []
    for (const root of this.home.config.projectRoots.map(expand)) {
      let names: string[] = []
      try {
        names = readdirSync(root)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith('.') || SKIP.has(name)) continue
        const p = join(root, name)
        try {
          if (statSync(p).isDirectory()) dirs.push(p)
        } catch {
          /* unreadable: skip */
        }
      }
    }

    interface Found {
      path: string
      isGit: boolean
      common: string | null
      linked: boolean
      lastCommit: number | null
      dirty: boolean
      description: string
      hasInstructions: boolean
      stack: string
    }
    const found: Found[] = []
    let next = 0
    const worker = async () => {
      while (next < dirs.length) {
        const path = dirs[next++]!
        const dotGit = join(path, '.git')
        const isGit = existsSync(dotGit)
        let common: string | null = null
        let linked = false
        let lastCommit: number | null = null
        let dirty = false
        if (isGit) {
          linked = statSync(dotGit).isFile()
          const c = await gitOut(path, ['rev-parse', '--git-common-dir'])
          common = c ? (isAbsolute(c) ? c : resolve(path, c)) : null
          // The same .git reached through a symlink must still be the same lock.
          try {
            if (common) common = realpathSync.native(common)
          } catch {
            /* keep the unresolved path */
          }
          const t = await gitOut(path, ['log', '-1', '--format=%ct'])
          lastCommit = t && /^\d+$/.test(t) ? Number(t) * 1000 : null
          const s = await gitOut(path, ['status', '--porcelain', '--untracked-files=normal'], 20_000)
          dirty = s !== null && s.length > 0
        }
        const d = describe(path)
        found.push({ path, isGit, common, linked, lastCommit, dirty, description: d.text, hasInstructions: d.hasInstructions, stack: detectStack(path) })
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))

    const now = Date.now()
    this.db.tx(() => {
      // Main checkouts first, so a linked worktree can point at its parent.
      found.sort((a, b) => Number(a.linked) - Number(b.linked) || a.path.localeCompare(b.path))
      for (const f of found) {
        const existing = this.db.get<ProjectRow>('select * from projects where path = ?', f.path)
        const slug = existing?.slug ?? this.freeSlug(slugify(basename(f.path)), f.path)
        let parent: string | null = null
        if (f.linked && f.common && basename(f.common) === '.git') {
          parent = this.db.get<{ slug: string }>('select slug from projects where git_common_dir = ? and path != ?', f.common, f.path)?.slug ?? null
        }
        if (existing) {
          this.db.run(
            `update projects set description = ?, stack = ?, is_git = ?, git_common_dir = ?, parent_slug = ?, last_commit_at = ?, dirty = ?, has_instructions = ?, missing = 0, scanned_at = ? where slug = ?`,
            f.description,
            f.stack,
            f.isGit ? 1 : 0,
            f.common,
            parent,
            f.lastCommit,
            f.dirty ? 1 : 0,
            f.hasInstructions ? 1 : 0,
            now,
            slug,
          )
        } else {
          this.db.run(
            `insert into projects (slug, name, path, kind, description, stack, is_git, git_common_dir, parent_slug, last_commit_at, dirty, has_instructions, created_at, scanned_at)
             values (?, ?, ?, 'code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            slug,
            basename(f.path),
            f.path,
            f.description,
            f.stack,
            f.isGit ? 1 : 0,
            f.common,
            parent,
            f.lastCommit,
            f.dirty ? 1 : 0,
            f.hasInstructions ? 1 : 0,
            now,
            now,
          )
        }
      }
      // Folders that have gone are kept (their tasks still point at them) but marked.
      this.db.run(`update projects set missing = 1 where kind = 'code' and (scanned_at is null or scanned_at < ?)`, now)
    })
    this.giveKeys()
    return found.length
  }
}
