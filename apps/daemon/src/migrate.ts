// HeyBotOS was called BotOS. An installation from then is carried over the first time the new
// one starts: the old background service is stopped and removed, the data folder moves from
// ~/botos to ~/heybotos, and every path stored in the database follows it. Nothing is deleted;
// the database and the config as they were are kept in a folder beside the new ones.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, sep } from 'node:path'
import type { Db } from './db.ts'
import { GIT } from './platform.ts'

const OLD_NAME = 'botos'
const OLD_LABEL = 'com.botos.daemon'
const MARK = 'moved-from.json'

function answers(port: number): boolean {
  try {
    execFileSync('/usr/bin/nc', ['-z', '-G', '1', '127.0.0.1', String(port)], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/** Stop the background service of the old name and take its start-up entry away. */
export function retireOldService(home = homedir()): void {
  if (process.platform !== 'darwin') return
  const plist = join(home, 'Library', 'LaunchAgents', `${OLD_LABEL}.plist`)
  if (!existsSync(plist)) return
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${userInfo().uid}/${OLD_LABEL}`], { stdio: 'ignore' })
  } catch {
    /* it was not loaded */
  }
  rmSync(plist, { force: true })
}

/**
 * Move the old data folder to the new place. Does nothing when there is no old folder, or when the
 * new one already exists. Returns the old path when it moved something.
 */
export function moveOldHome(home = homedir(), log: (line: string) => void = console.log): string | null {
  const old = join(home, OLD_NAME)
  const next = join(home, 'heybotos')
  if (!existsSync(join(old, 'state', `${OLD_NAME}.db`)) || existsSync(next)) return null

  retireOldService(home)
  let port = 4747
  try {
    port = Number((JSON.parse(readFileSync(join(old, 'config', `${OLD_NAME}.json`), 'utf8')) as { port?: number }).port ?? 4747)
  } catch {
    /* the default */
  }
  // The old service lets go of the database when it stops; give it a moment, then insist.
  for (let i = 0; i < 40 && answers(port); i++) execFileSync('/bin/sleep', ['0.25'])
  if (answers(port)) throw new Error(`An earlier BotOS is still running on port ${port}. Stop it, then start HeyBotOS again; your data in ${old} is moved over then.`)

  const keep = join(old, 'before-heybotos')
  mkdirSync(keep, { recursive: true })
  for (const f of [`${OLD_NAME}.db`, `${OLD_NAME}.db-wal`, `${OLD_NAME}.db-shm`]) if (existsSync(join(old, 'state', f))) cpSync(join(old, 'state', f), join(keep, f))
  cpSync(join(old, 'config'), join(keep, 'config'), { recursive: true })

  renameSync(old, next)
  for (const [dir, from, to] of [
    ['config', `${OLD_NAME}.json`, 'heybotos.json'],
    ['state', `${OLD_NAME}.db`, 'heybotos.db'],
    ['state', `${OLD_NAME}.db-wal`, 'heybotos.db-wal'],
    ['state', `${OLD_NAME}.db-shm`, 'heybotos.db-shm'],
  ] as const) {
    if (existsSync(join(next, dir, from))) renameSync(join(next, dir, from), join(next, dir, to))
  }
  // Written again at every start, with the new names in them.
  for (const stale of ['shims', 'zdot', 'login-url']) rmSync(join(next, 'state', stale), { recursive: true, force: true })
  writeFileSync(join(next, 'state', MARK), JSON.stringify({ from: old, to: next, at: Date.now() }))
  log(`Your BotOS data was moved from ${old} to ${next}. The database and config as they were are kept in ${join(next, 'before-heybotos')}.`)
  return old
}

/** After the move: point every stored path at the new folder. Runs once, when the database is open. */
export function finishMove(root: string, db: Db, log: (line: string) => void = console.log): boolean {
  const mark = join(root, 'state', MARK)
  if (!existsSync(mark)) return false
  const { from, to } = JSON.parse(readFileSync(mark, 'utf8')) as { from: string; to: string }
  const columns: Array<[table: string, column: string]> = [
    ['tasks', 'cwd'],
    ['tasks', 'lock_key'],
    ['runs', 'cwd'],
    ['runs', 'lock_key'],
    ['runs', 'stdout_path'],
    ['runs', 'extra_json'],
    ['projects', 'path'],
    ['projects', 'git_common_dir'],
    ['files', 'path'],
  ]
  db.tx(() => {
    // Only the folder itself, never a neighbour whose name merely starts the same way.
    for (const [table, column] of columns) db.run(`update ${table} set ${column} = replace(${column}, ?, ?) where instr(${column}, ?) > 0`, `${from}${sep}`, `${to}${sep}`, `${from}${sep}`)
    // The manager's earlier session knows its tools by their old names: its next turn starts a new one.
    db.run(`update runs set session_id = null where role = 'manager'`)
  })
  // A task that works in a separate copy has that copy registered with its repository by path.
  for (const t of db.all<{ cwd: string; path: string }>(`select t.cwd, p.path from tasks t join projects p on p.slug = t.project_slug where t.isolation = 'worktree' and t.cwd like ?`, `${to}/%`)) {
    if (!existsSync(t.cwd)) continue
    try {
      execFileSync(GIT, ['-C', t.path, 'worktree', 'repair', t.cwd], { stdio: 'ignore', timeout: 20_000 })
    } catch {
      /* the copy stays where it is; git says so the next time it is used */
    }
  }
  renameSync(mark, join(root, 'state', 'moved-from.done.json'))
  log('Stored paths now point at the new data folder.')
  return true
}
