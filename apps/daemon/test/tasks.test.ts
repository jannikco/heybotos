import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskView } from '@heybotos/protocol'
import { FAKE, FIXTURES, makeWorld, until, variant, type World } from './helpers.ts'

let w: World
let repo: string
const git = (dir: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

/** A fake worker that really edits files, so baselines, diffs and undo have something to bite on. */
function scriptedWorker(script: string, fixture = join(FIXTURES, 'claude-rich.jsonl')): void {
  const bin = join(w.root, 'worker.sh')
  writeFileSync(bin, `#!/bin/sh\n${script}\nexec ${FAKE} "$@"\n`, { mode: 0o755 })
  w.home.config.engines.claude.bin = bin
  w.home.config.engines.claude.env = { FAKE_FIXTURE: fixture }
}

function makeRepo(name: string): string {
  const dir = join(w.root, 'code', name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@localhost')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nA small shop for printed things, used in tests.\n`)
  writeFileSync(join(dir, 'app.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'old.txt'), 'to be removed\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

const status = (id: string) => w.tasks.get(id)!.status

beforeEach(async () => {
  w = makeWorld()
  repo = makeRepo('shop')
  await w.registry.scan()
  w.sup.start()
})
afterEach(() => w.cleanup())

describe('the project list', () => {
  it('finds folders, reads what they are, and attaches linked worktrees to their repository', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { vue: '3' } }))
    writeFileSync(join(repo, 'CLAUDE.md'), '# Rules\n\nAlways run the tests before you say something is done.\n')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', join(w.root, 'code', 'shop-wt'))
    mkdirSync(join(w.root, 'code', 'plain-notes'))
    expect(await w.registry.scan()).toBe(3)

    const shop = w.registry.get('shop')!
    expect(shop).toMatchObject({ name: 'shop', isGit: true, stack: 'Vue', hasInstructions: true, dirty: true, parentSlug: null, missing: false })
    expect(shop.description).toBe('Always run the tests before you say something is done.')
    expect(shop.lastCommitAt).toBeGreaterThan(Date.now() - 60_000)
    expect(w.registry.get('shop-wt')).toMatchObject({ isGit: true, parentSlug: 'shop' })
    expect(w.registry.get('plain-notes')).toMatchObject({ isGit: false, dirty: false })
    expect(w.registry.find('SHOP')?.slug).toBe('shop')
    expect(w.registry.find(repo)?.slug).toBe('shop')
  })

  it('keeps a project whose folder vanished, marked as missing, and keeps your notes across scans', async () => {
    mkdirSync(join(w.root, 'code', 'gone-soon'))
    await w.registry.scan()
    w.registry.setNotes('shop', 'Deploys on Fridays are not allowed.')
    rmSync(join(w.root, 'code', 'gone-soon'), { recursive: true })
    await w.registry.scan()
    expect(w.registry.get('gone-soon')!.missing).toBe(true)
    expect(w.registry.get('shop')!.notes).toBe('Deploys on Fridays are not allowed.')
    expect(() => w.tasks.create({ project: 'gone-soon', brief: 'x' })).toThrow(/is gone/)
  })

  it('creates a non-code project with its own workspace and notes file', () => {
    const p = w.registry.createOther('Move to Cyprus', 'Everything about the move.')
    expect(p).toMatchObject({ slug: 'move-to-cyprus', kind: 'other', isGit: false })
    expect(readFileSync(join(p.path, 'notes.md'), 'utf8')).toBe('Everything about the move.\n')
    w.registry.setNotes(p.slug, 'Flights booked.')
    expect(readFileSync(join(p.path, 'notes.md'), 'utf8')).toBe('Flights booked.')
    expect(() => w.registry.createOther('move to cyprus')).toThrow(/already a project/)
  })
})

describe('a task from start to finish', () => {
  it('runs in the project folder, records what changed, and ends done with the report summary', async () => {
    scriptedWorker('printf "one\\nTWO\\nthree\\n" > app.txt; echo new > added.txt; rm old.txt')
    writeFileSync(join(repo, 'mine.txt'), 'my own uncommitted work\n') // the owner's work in progress
    const seen: TaskView[] = []
    w.bus.on('task', (t) => seen.push(t))

    const t = w.tasks.create({ project: 'shop', brief: 'Fix the header overlap on phones.', kind: 'build' })
    expect(['queued', 'running']).toContain(t.status)
    await until(() => status(t.id) === 'done')

    const done = w.tasks.get(t.id)!
    expect(done.summary).toMatch(/nav no longer slides under the header/)
    expect(done.hasBaseline).toBe(true)
    expect(seen.map((x) => x.status)).toEqual(expect.arrayContaining(['queued', 'running', 'done']))
    const run = w.tasks.runs(t.id)[0]!
    expect(run.cwd).toBe(repo)
    expect(run.taskId).toBe(t.id)

    const changes = w.tasks.changes(t.id)
    expect(changes.available).toBe(true)
    expect(changes.files).toEqual([
      { path: 'added.txt', status: 'added', added: 1, removed: 0 },
      { path: 'app.txt', status: 'changed', added: 2, removed: 1 },
      { path: 'old.txt', status: 'deleted', added: 0, removed: 1 },
    ])
    expect(changes.patch).toContain('+TWO')
    // The owner's own uncommitted file was there before, so it is not counted as the task's change.
    expect(changes.files.some((f) => f.path === 'mine.txt')).toBe(false)
    // Taking snapshots touched neither the branch nor the staging area.
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1)
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heybotos/')).toContain(`refs/heybotos/${t.id}/baseline`)
  })

  it('gives the worker its rules, the project notes and the report schema', async () => {
    w.registry.setNotes('shop', 'The staging site is shop-staging.')
    const t = w.tasks.create({ project: 'shop', title: 'Review the header fix', brief: 'Look at the last change.', kind: 'review' })
    await until(() => status(t.id) !== 'queued' && status(t.id) !== 'running')
    const dir = join(w.home.runs, w.tasks.get(t.id)!.lastRunId!)
    const system = readFileSync(join(dir, 'system.md'), 'utf8')
    expect(system).toContain('You are a worker agent started by HeyBotOS')
    expect(system).toContain('This is a review. Do not change any files.')
    expect(system).toContain('The staging site is shop-staging.')
    expect(system).toContain(`HeyBotOS task id: ${t.id}`)
    expect(existsSync(join(dir, 'report.schema.json'))).toBe(true)
  })

  it('undoes everything the task changed and leaves the owner\'s other work alone', async () => {
    scriptedWorker('printf "changed\\n" > app.txt; echo new > added.txt; rm old.txt')
    writeFileSync(join(repo, 'mine.txt'), 'my own uncommitted work\n')
    const t = w.tasks.create({ project: 'shop', brief: 'Change things.' })
    await until(() => status(t.id) === 'done')

    expect(w.tasks.undo(t.id)).toEqual({ files: 3 })
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(readFileSync(join(repo, 'old.txt'), 'utf8')).toBe('to be removed\n')
    expect(existsSync(join(repo, 'added.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('my own uncommitted work\n')
    expect(w.tasks.changes(t.id).files).toEqual([])
    // The undo itself can be taken back: the state before it is kept.
    const before = git(repo, 'rev-parse', `refs/heybotos/${t.id}/before-undo`)
    expect(git(repo, 'show', `${before}:app.txt`)).toBe('changed')
  })

  it('says plainly when a folder is not a git repository and nothing can be shown or undone', async () => {
    mkdirSync(join(w.root, 'code', 'notes'))
    await w.registry.scan()
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    const t = w.tasks.create({ project: 'notes', brief: 'Tidy the notes.' })
    await until(() => status(t.id) === 'done')
    expect(w.tasks.changes(t.id)).toMatchObject({ available: false, reason: expect.stringMatching(/not a git repository/) })
    expect(() => w.tasks.undo(t.id)).toThrow(/nothing to undo/)
  })
})

describe('a plain folder inside someone else\'s repository', () => {
  it('is not treated as that repository: no snapshot of it, no undo across it', async () => {
    const inner = join(repo, 'docs-drafts')
    mkdirSync(inner)
    writeFileSync(join(inner, 'draft.md'), 'draft\n')
    w.home.config.projectRoots = [repo]
    await w.registry.scan()
    expect(w.registry.get('docs-drafts')).toMatchObject({ isGit: false })
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    const t = w.tasks.create({ project: 'docs-drafts', brief: 'Tidy the drafts.' })
    await until(() => status(t.id) === 'done')
    expect(w.tasks.get(t.id)!.hasBaseline).toBe(false)
    expect(w.tasks.changes(t.id)).toMatchObject({ available: false, reason: expect.stringMatching(/not a git repository/) })
    expect(git(repo, 'for-each-ref', 'refs/heybotos/')).toBe('')
  })
})

describe('questions and follow-ups', () => {
  it('parks a task that needs an answer, then resumes the same session with it', async () => {
    const asking = variant(w.root, 'asking', (lines) =>
      lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { status: 'needs_input', summary: 'Two layouts are possible.', question: 'Sticky header or static?', files_changed: [], verification: '', follow_ups: [] } } : l)),
    )
    w.home.config.engines.claude.env = { FAKE_FIXTURE: asking }
    const t = w.tasks.create({ project: 'shop', brief: 'Rework the header.' })
    await until(() => status(t.id) === 'needs_input')
    expect(w.tasks.get(t.id)!.question).toBe('Sticky header or static?')
    expect(w.sup.activeCount()).toBe(0) // waiting on a person holds no worker slot

    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_ARGS_OUT: join(w.root, 'args.json'), FAKE_STDIN_OUT: join(w.root, 'stdin.txt') }
    w.tasks.answer(t.id, 'Sticky.')
    await until(() => status(t.id) === 'done')
    const runs = w.tasks.runs(t.id)
    expect(runs.map((r) => r.turn)).toEqual([1, 2])
    expect(runs[1]!.sessionId).toBe(runs[0]!.sessionId)
    expect(JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))).toContain('--resume')
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toBe('Sticky.')
    expect(w.tasks.get(t.id)!.question).toBeNull()
  })

  it('maps blocked and failed reports, and a crashed worker, to the right task state', async () => {
    for (const [reported, expected] of [['blocked', 'blocked'], ['failed', 'failed']] as const) {
      const f = variant(w.root, reported, (lines) => lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { status: reported, summary: `It is ${reported}.` } } : l)))
      w.home.config.engines.claude.env = { FAKE_FIXTURE: f }
      const t = w.tasks.create({ project: 'shop', brief: `Be ${reported}.` })
      await until(() => status(t.id) === expected)
      expect(w.tasks.get(t.id)!.summary).toBe(`It is ${reported}.`)
    }
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'crash' }
    const t = w.tasks.create({ project: 'shop', brief: 'Crash.' })
    await until(() => status(t.id) === 'failed')
    expect(w.tasks.get(t.id)!.summary).toMatch(/ended without a result/)
  })

  it('does not count a run as done when the report is missing', async () => {
    const t = w.tasks.create({ project: 'shop', brief: 'No report.' }) // the basic fixture has no structured report
    await until(() => status(t.id) === 'failed')
    expect(w.tasks.get(t.id)!.summary).toMatch(/without handing in its report/)
  })

  it('stops a working task and lets it be picked up again', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'hang' }
    const t = w.tasks.create({ project: 'shop', brief: 'Long job.' })
    await until(() => status(t.id) === 'running')
    expect(() => w.tasks.answer(t.id, 'hurry')).toThrow(/working right now/)
    w.tasks.stop(t.id)
    await until(() => status(t.id) === 'cancelled')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    w.tasks.start(t.id)
    await until(() => status(t.id) === 'done')
    expect(w.tasks.runs(t.id)).toHaveLength(2)
  })
})

describe('order and isolation', () => {
  beforeEach(() => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_DELAY_MS: '3' }
  })

  it('starts a task that depends on another only when that one is done', async () => {
    const build = w.tasks.create({ project: 'shop', brief: 'Build the thing.', kind: 'build' })
    const review = w.tasks.create({ project: 'shop', brief: 'Review the thing.', kind: 'review', dependsOn: [build.id] })
    expect(review.status).toBe('queued')
    expect(review.waitReason).toMatch(/Waiting for "Build the thing\." to finish/)
    expect(review.lastRunId).toBeNull()
    await until(() => status(review.id) === 'done')
    const [b, r] = [w.tasks.runs(build.id)[0]!, w.tasks.runs(review.id)[0]!]
    expect(r.createdAt).toBeGreaterThanOrEqual(b.endedAt!)
  })

  it('leaves a dependent waiting when the task it depends on fails', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'crash' }
    const build = w.tasks.create({ project: 'shop', brief: 'Build.' })
    const review = w.tasks.create({ project: 'shop', brief: 'Review.', dependsOn: [build.id] })
    await until(() => status(build.id) === 'failed')
    expect(status(review.id)).toBe('queued')
    expect(() => w.tasks.create({ project: 'shop', brief: 'x', dependsOn: ['t_nope'] })).toThrow(/does not exist/)
  })

  it('runs one worker at a time in a repository, including its linked worktrees', async () => {
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', join(w.root, 'code', 'shop-wt'))
    await w.registry.scan()
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'hang' }
    const a = w.tasks.create({ project: 'shop', brief: 'A.' })
    await until(() => status(a.id) === 'running')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    const b = w.tasks.create({ project: 'shop-wt', brief: 'B.' })
    await new Promise((r) => setTimeout(r, 150))
    expect(status(b.id)).toBe('queued')
    expect(w.tasks.get(b.id)!.waitReason).toMatch(/another worker in the same folder/)
    w.tasks.stop(a.id)
    await until(() => status(b.id) === 'done')
  })

  it('gives a task its own branch and folder when asked, so it can run alongside other work', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'hang' }
    const a = w.tasks.create({ project: 'shop', brief: 'A in the main folder.' })
    await until(() => status(a.id) === 'running')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    const b = w.tasks.create({ project: 'shop', brief: 'B in its own copy.', isolation: 'worktree' })
    await until(() => status(b.id) === 'done')
    const done = w.tasks.get(b.id)!
    expect(done.cwd).toBe(join(w.home.worktrees, b.id))
    expect(git(done.cwd, 'branch', '--show-current')).toBe(`heybotos/${b.id}`)
    expect(status(a.id)).toBe('running')
    expect(() => w.tasks.create({ project: w.registry.createOther('Plans').slug, brief: 'x', isolation: 'worktree' })).toThrow(/not a git repository/)
  })
})
