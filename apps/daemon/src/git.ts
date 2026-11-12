// Git plumbing for baselines, diffs and undo. Nothing here touches the user's index, branch or stash:
// snapshots are built in a throwaway index file and kept alive by refs under refs/heybotos/.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileChange } from '@heybotos/protocol'

const GIT = '/usr/bin/git'
const IDENTITY = {
  GIT_AUTHOR_NAME: 'HeyBotOS',
  GIT_AUTHOR_EMAIL: 'heybotos@localhost',
  GIT_COMMITTER_NAME: 'HeyBotOS',
  GIT_COMMITTER_EMAIL: 'heybotos@localhost',
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra }
}

export function git(repo: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number } = {}): string {
  return execFileSync(GIT, ['-C', repo, ...args], {
    env: cleanEnv(opts.env),
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd()
}

export function tryGit(repo: string, args: string[], opts: Parameters<typeof git>[2] = {}): string | null {
  try {
    return git(repo, args, opts)
  } catch {
    return null
  }
}

/**
 * True only when `dir` is itself the top of a working tree. A plain folder that happens to sit
 * somewhere inside another repository is not that repository: snapshotting or restoring "it"
 * would act on the outer project.
 */
export function isRepo(dir: string): boolean {
  const top = tryGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  if (!top) return false
  try {
    return realpathSync(top) === realpathSync(dir)
  } catch {
    return false
  }
}

/** The shared .git directory: the same for a repository and all of its linked worktrees. */
export function commonDir(dir: string): string | null {
  const out = tryGit(dir, ['rev-parse', '--git-common-dir'], { timeoutMs: 10_000 })
  if (!out) return null
  return isAbsolute(out) ? out : resolve(dir, out)
}

/**
 * A commit that records the folder exactly as it is now: tracked and untracked files, minus what
 * .gitignore excludes. Built in a temporary index, so the user's staging area is not touched.
 */
export function snapshot(repo: string, label: string): string {
  const index = join(tmpdir(), `heybotos-index-${randomBytes(6).toString('hex')}`)
  const env = { GIT_INDEX_FILE: index, ...IDENTITY }
  try {
    const head = tryGit(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
    // Starting from a copy of the real index keeps its stat cache, so unchanged files are not re-read.
    const real = tryGit(repo, ['rev-parse', '--git-path', 'index'])
    const realPath = real ? (isAbsolute(real) ? real : resolve(repo, real)) : null
    if (realPath && existsSync(realPath)) {
      copyFileSync(realPath, index)
      // Git decides whether a cached entry can be trusted by comparing file times with the index
      // file's own time. A fresh copy looks newer than it is, and a same-size edit made in the same
      // second as the last "git add" would be missed. Give the copy the original's time (rounded
      // down, which only makes git re-check more).
      const t = Math.floor(statSync(realPath).mtimeMs) / 1000
      utimesSync(index, t, t)
    } else if (head) git(repo, ['read-tree', head], { env })
    git(repo, ['add', '-A', '--', '.'], { env, timeoutMs: 180_000 })
    const tree = git(repo, ['write-tree'], { env })
    const args = ['commit-tree', tree, '-m', label]
    if (head) args.push('-p', head)
    return git(repo, args, { env })
  } finally {
    rmSync(index, { force: true })
    rmSync(`${index}.lock`, { force: true })
  }
}

/** Keep a snapshot from being garbage-collected. */
export function keep(repo: string, name: string, commit: string): void {
  git(repo, ['update-ref', `refs/heybotos/${name}`, commit])
}

export function changesBetween(repo: string, from: string, to: string): FileChange[] {
  const status = new Map<string, FileChange['status']>()
  const names = git(repo, ['diff', '--name-status', '--no-renames', '-z', from, to]).split('\0')
  for (let i = 0; i + 1 < names.length; i += 2) {
    const code = names[i]!
    status.set(names[i + 1]!, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'changed')
  }
  const out: FileChange[] = []
  for (const row of git(repo, ['diff', '--numstat', '--no-renames', '-z', from, to]).split('\0')) {
    if (!row) continue
    const [added = '0', removed = '0', ...rest] = row.split('\t')
    const path = rest.join('\t')
    out.push({ path, status: status.get(path) ?? 'changed', added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function patchBetween(repo: string, from: string, to: string, maxBytes = 300_000): { patch: string; clipped: boolean } {
  const patch = git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-renames', from, to])
  return patch.length > maxBytes ? { patch: patch.slice(0, maxBytes), clipped: true } : { patch, clipped: false }
}

/**
 * Put every file that differs between `from` and `to` back to how it was in `from`.
 * Only the working folder changes; the branch, the commits and the staging area stay as they are.
 */
export function restore(repo: string, from: string, to: string): number {
  const changes = changesBetween(repo, from, to)
  const back = changes.filter((c) => c.status !== 'added').map((c) => c.path)
  if (back.length) {
    git(repo, ['restore', `--source=${from}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: back.join('\0') })
  }
  for (const c of changes.filter((c) => c.status === 'added')) {
    try {
      unlinkSync(join(repo, c.path))
    } catch {
      /* already gone */
    }
  }
  return changes.length
}

export function addWorktree(repo: string, dir: string, branch: string): void {
  git(repo, ['worktree', 'add', '-b', branch, dir], { timeoutMs: 180_000 })
}
