// An installation from when HeyBotOS was called BotOS is carried over: folder, file names and
// every path stored in the database.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db.ts'
import { finishMove, moveOldHome } from '../src/migrate.ts'

let home: string
let old: string
let next: string
const said: string[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'heybotos-move-'))
  old = join(home, 'botos')
  next = join(home, 'heybotos')
  said.length = 0
  for (const d of ['state/runs/r_1', 'state/shims', 'config', 'projects/notes', 'worktrees/t_wt', 'files/f_aaaaaaaaaaaa']) mkdirSync(join(old, d), { recursive: true })
  // A free port, so the check that the old service has stopped finds nobody there.
  writeFileSync(join(old, 'config', 'botos.json'), JSON.stringify({ port: 59_731, maxWorkers: 5 }))
  writeFileSync(join(old, 'config', 'gate.json'), '{"allowedHosts":["web1"]}')
  writeFileSync(join(old, 'state', 'secret'), 'the-secret')
  writeFileSync(join(old, 'state', 'login-url'), 'http://old')
  writeFileSync(join(old, 'files', 'f_aaaaaaaaaaaa', 'shot.png'), 'png')
  const db = new Db(join(old, 'state', 'botos.db'))
  db.run(`insert into projects (slug, name, path, kind, created_at) values ('notes', 'Notes', ?, 'other', 1), ('shop', 'shop', ?, 'code', 1)`, join(old, 'projects', 'notes'), join(home, 'code', 'shop'))
  db.run(
    `insert into tasks (id, project_slug, title, brief, status, cwd, lock_key, isolation, created_at, updated_at, number) values
      ('t_wt', 'shop', 'Apart', 'b', 'done', ?, ?, 'worktree', 1, 1, 1), ('t_in', 'shop', 'In place', 'b', 'done', ?, ?, 'direct', 2, 2, 2), ('t_near', 'shop', 'Neighbour', 'b', 'done', ?, ?, 'direct', 3, 3, 3)`,
    join(old, 'worktrees', 't_wt'),
    join(old, 'worktrees', 't_wt'),
    join(home, 'code', 'shop'),
    join(home, 'code', 'shop'),
    `${old}-archive/x`,
    `${old}-archive/x`,
  )
  db.run(
    `insert into runs (id, task_id, engine, role, title, prompt, cwd, session_id, status, stdout_path, extra_json, created_at) values
      ('r_1', 't_wt', 'claude', 'ada', 'Apart', 'p', ?, 's-1', 'done', ?, ?, 1), ('r_m', null, 'claude', 'manager', 'Manager', 'p', ?, 's-m', 'done', null, null, 2)`,
    join(old, 'worktrees', 't_wt'),
    join(old, 'state', 'runs', 'r_1', 'stdout.jsonl'),
    JSON.stringify({ systemPrompt: `You are in ${join(old, 'worktrees', 't_wt')}.` }),
    join(old, 'manager'),
  )
  db.run(`insert into files (id, name, mime, size, path, created_at) values ('f_aaaaaaaaaaaa', 'shot.png', 'image/png', 3, ?, 1)`, join(old, 'files', 'f_aaaaaaaaaaaa', 'shot.png'))
  db.close()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('carrying an old installation over', () => {
  it('moves the folder, renames what carried the old name, and keeps the old database and config', () => {
    expect(moveOldHome(home, (l) => said.push(l))).toBe(old)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(next, 'state', 'heybotos.db'))).toBe(true)
    expect(existsSync(join(next, 'state', 'botos.db'))).toBe(false)
    expect(JSON.parse(readFileSync(join(next, 'config', 'heybotos.json'), 'utf8'))).toMatchObject({ port: 59_731, maxWorkers: 5 })
    expect(readFileSync(join(next, 'config', 'gate.json'), 'utf8')).toContain('web1')
    expect(readFileSync(join(next, 'state', 'secret'), 'utf8')).toBe('the-secret')
    expect(existsSync(join(next, 'state', 'shims'))).toBe(false)
    expect(existsSync(join(next, 'state', 'login-url'))).toBe(false)
    expect(existsSync(join(next, 'before-heybotos', 'botos.db'))).toBe(true)
    expect(existsSync(join(next, 'before-heybotos', 'config', 'botos.json'))).toBe(true)
    expect(said[0]).toContain(`was moved from ${old} to ${next}`)
    // Once only.
    expect(moveOldHome(home)).toBeNull()
  })

  it('points every stored path at the new folder, and nothing else', () => {
    moveOldHome(home, () => {})
    const db = new Db(join(next, 'state', 'heybotos.db'))
    expect(finishMove(next, db, () => {})).toBe(true)
    const one = <T>(sql: string) => db.get<T>(sql)!
    expect(one<{ path: string }>(`select path from projects where slug = 'notes'`).path).toBe(join(next, 'projects', 'notes'))
    expect(one<{ path: string }>(`select path from projects where slug = 'shop'`).path).toBe(join(home, 'code', 'shop'))
    expect(one<{ cwd: string; lock_key: string }>(`select cwd, lock_key from tasks where id = 't_wt'`)).toEqual({ cwd: join(next, 'worktrees', 't_wt'), lock_key: join(next, 'worktrees', 't_wt') })
    expect(one<{ cwd: string }>(`select cwd from tasks where id = 't_in'`).cwd).toBe(join(home, 'code', 'shop'))
    expect(one<{ cwd: string }>(`select cwd from tasks where id = 't_near'`).cwd).toBe(`${old}-archive/x`)
    const run = one<{ cwd: string; stdout_path: string; extra_json: string; session_id: string | null }>(`select cwd, stdout_path, extra_json, session_id from runs where id = 'r_1'`)
    expect(run).toMatchObject({ cwd: join(next, 'worktrees', 't_wt'), stdout_path: join(next, 'state', 'runs', 'r_1', 'stdout.jsonl'), session_id: 's-1' })
    expect(run.extra_json).toContain(join(next, 'worktrees', 't_wt'))
    expect(one<{ session_id: string | null }>(`select session_id from runs where id = 'r_m'`).session_id).toBeNull()
    const file = one<{ path: string }>('select path from files')
    expect(file.path).toBe(join(next, 'files', 'f_aaaaaaaaaaaa', 'shot.png'))
    expect(readFileSync(file.path, 'utf8')).toBe('png')
    // The numbers and keys the old tasks were given survive.
    expect(db.all<{ number: number }>('select number from tasks order by number').map((t) => t.number)).toEqual([1, 2, 3])
    expect(finishMove(next, db, () => {})).toBe(false)
    db.close()
  })

  it('leaves everything alone when there is nothing old, or the new folder is already there', () => {
    mkdirSync(next)
    expect(moveOldHome(home)).toBeNull()
    expect(existsSync(join(old, 'state', 'botos.db'))).toBe(true)
    rmSync(old, { recursive: true })
    rmSync(next, { recursive: true })
    expect(moveOldHome(home)).toBeNull()
  })
})
