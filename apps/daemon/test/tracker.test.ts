// The tracker: task numbers, the backlog and the board's moves, fields and their history, comments,
// files, links, search, and what of all that reaches the worker.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { MIGRATIONS } from '../src/db.ts'
import { safeName } from '../src/files.ts'
import { keyFrom } from '../src/registry.ts'
import { FIXTURES, git, makeWorld, until, variant, type World } from './helpers.ts'

let w: World
const RICH = join(FIXTURES, 'claude-rich.jsonl')

function makeRepo(name: string): string {
  const dir = join(w.root, 'code', name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@localhost')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nA small shop for printed things, used in tests.\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

const status = (id: string) => w.tasks.get(id)!.status
const stage = (id: string) => w.tasks.get(id)!.stage
const upload = (name: string, text: string, mime = 'text/plain') => w.tasks.files.save(name, mime, new Blob([text]).stream() as ReadableStream<Uint8Array>)
const history = (id: string) => w.tasks.detail(id)!.history.map((h) => `${h.actorName}: ${h.what} ${h.from ?? ''}→${h.to ?? ''}`)

beforeEach(async () => {
  w = makeWorld()
  makeRepo('shop')
  makeRepo('shopfront')
  await w.registry.scan()
  w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH }
  w.sup.start()
})
afterEach(() => w.cleanup())

describe('task numbers', () => {
  it('makes a key from a name', () => {
    expect(keyFrom('HeyBotOS')).toBe('HEY')
    expect(keyFrom('printshop_v3')).toBe('PRI')
    expect(keyFrom('firma-julekort-2026')).toBe('FJ2')
    expect(keyFrom('c2p-wt')).toBe('C2P')
    expect(keyFrom('2026-plans')).toBe('P202')
    expect(keyFrom('x')).toBe('XX')
  })

  it('gives every project a key of its own and every task the next number', () => {
    const keys = Object.fromEntries(w.registry.list().map((p) => [p.slug, p.key]))
    expect(keys).toEqual({ shop: 'SHO', shopfront: 'SHOP' })
    const a = w.tasks.create({ project: 'shop', brief: 'First.', start: false })
    const b = w.tasks.create({ project: 'shop', brief: 'Second.', start: false })
    const c = w.tasks.create({ project: 'shopfront', brief: 'Elsewhere.', start: false })
    expect([a.key, b.key, c.key]).toEqual(['SHO-1', 'SHO-2', 'SHOP-1'])
    expect(w.tasks.resolve('sho-2')!.id).toBe(b.id)
    expect(w.tasks.resolve(b.id)!.key).toBe('SHO-2')
    expect(w.tasks.resolve('SHO-9')).toBeUndefined()
    expect(w.tasks.resolve('NOPE-1')).toBeUndefined()
  })

  it('lets the owner change a key, and refuses one that is taken or malformed', () => {
    const a = w.tasks.create({ project: 'shop', brief: 'First.', start: false })
    expect(() => w.registry.update('shop', { key: 'SHOP' })).toThrow('SHOP is already the key of shopfront.')
    expect(() => w.registry.update('shop', { key: '1x' })).toThrow(/two to six letters and digits/)
    expect(w.registry.update('shop', { key: 'web', starred: true })).toMatchObject({ key: 'WEB', starred: true })
    expect(w.tasks.get(a.id)!.key).toBe('WEB-1')
    expect(w.registry.find('web')!.slug).toBe('shop')
  })

  it('numbers the tasks that were there before tasks had numbers, oldest first', async () => {
    w.cleanup()
    w = makeWorld((home) => {
      const raw = new DatabaseSync(home.dbPath)
      raw.exec('create table schema_version (v integer not null)')
      MIGRATIONS.slice(0, 11).forEach((sql, i) => {
        raw.exec(sql)
        raw.prepare('insert into schema_version (v) values (?)').run(i + 1)
      })
      raw.prepare(`insert into projects (slug, name, path, created_at) values ('old', 'Old Things', ?, 1)`).run(join(home.root, 'code', 'old'))
      const add = raw.prepare(`insert into tasks (id, project_slug, title, brief, status, cwd, lock_key, created_at, updated_at) values (?, 'old', ?, 'b', 'done', '/x', '/x', ?, ?)`)
      add.run('t_second', 'Second', 200, 200)
      add.run('t_first', 'First', 100, 100)
      raw.close()
    })
    expect(w.tasks.get('t_first')).toMatchObject({ key: 'OLD-1', stage: 'done', priority: 'normal', labels: [], rank: 100 })
    expect(w.tasks.get('t_second')!.key).toBe('OLD-2')
    mkdirSync(join(w.root, 'code', 'old'), { recursive: true })
    expect(w.tasks.create({ project: 'old', brief: 'Third.', start: false }).key).toBe('OLD-3')
  })
})

describe('the backlog and the board', () => {
  it('keeps a task in the backlog until it is moved on, then lets it reach done by itself', async () => {
    const t = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Fix the header.', start: false, priority: 'high', labels: ['bug', ' bug ', 'nav'], dueAt: Date.parse('2026-11-20T12:00:00') })
    expect(t).toMatchObject({ status: 'todo', stage: 'backlog', priority: 'high', labels: ['bug', 'nav'], lastRunId: null })
    expect(w.sup.activeCount()).toBe(0)
    w.tasks.move(t.id, { stage: 'doing' })
    await until(() => stage(t.id) === 'done')
    expect(history(t.id).reverse()).toEqual(['You: created →', 'HeyBotOS: status Backlog→Up next', 'HeyBotOS: status Up next→In progress', 'Ada: status In progress→Done'])
  })

  it('parks a working task that is moved back to the backlog, instead of closing it', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_MODE: 'hang' }
    const t = w.tasks.create({ project: 'shop', brief: 'A long job.' })
    await until(() => status(t.id) === 'running' && w.sup.view(w.tasks.get(t.id)!.lastRunId!)!.status === 'running')
    expect(() => w.tasks.move(t.id, { stage: 'done' })).toThrow('A worker is on this task. Stop it first, or wait for its report.')
    w.tasks.move(t.id, { stage: 'backlog' })
    await until(() => status(t.id) === 'todo')
    expect(w.sup.activeCount()).toBe(0)
    // A plain stop still closes it.
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_MODE: 'hang' }
    w.tasks.move(t.id, { stage: 'next' })
    await until(() => status(t.id) === 'running' && w.sup.view(w.tasks.get(t.id)!.lastRunId!)!.status === 'running')
    w.tasks.stop(t.id)
    await until(() => status(t.id) === 'cancelled')
    expect(stage(t.id)).toBe('done')
  })

  it('closes a task by hand, which starts what was waiting for it, and reopens it', async () => {
    const first = w.tasks.create({ project: 'shop', brief: 'Decide the layout.', start: false })
    const second = w.tasks.create({ project: 'shop', brief: 'Build the layout.', dependsOn: [first.key] })
    expect(w.tasks.get(second.id)).toMatchObject({ status: 'queued', stage: 'next', waitReason: 'Waiting for "Decide the layout." to finish.' })
    expect(() => w.tasks.move(first.id, { stage: 'needs_you' })).toThrow(/lands in "Needs you" by itself/)
    expect(w.tasks.move(first.id, { stage: 'done' })).toMatchObject({ status: 'done', closedBy: 'user', stage: 'done' })
    await until(() => status(second.id) === 'done')
    expect(w.tasks.runs(first.id)).toHaveLength(0)

    expect(w.tasks.move(first.id, { stage: 'backlog' })).toMatchObject({ status: 'todo', closedBy: null })
    expect(w.tasks.move(first.id, { stage: 'done', wontDo: true })).toMatchObject({ status: 'cancelled', closedBy: 'user' })
  })

  it('orders tasks by where they were dropped', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((title) => w.tasks.create({ project: 'shop', title, brief: title, start: false }))
    const order = () =>
      w.tasks
        .list()
        .sort((x, y) => x.rank - y.rank)
        .map((t) => t.title)
        .join('')
    w.tasks.move(c!.id, { before: a!.id })
    expect(order()).toBe('CAB')
    w.tasks.move(c!.id, { after: a!.id, before: b!.id })
    expect(order()).toBe('ACB')
    w.tasks.move(a!.id, { after: b!.id })
    expect(order()).toBe('CBA')
    // Dropped between the same two again and again, there is always room.
    for (let i = 0; i < 80; i++) w.tasks.move(i % 2 ? a!.id : c!.id, { after: b!.id, before: i % 2 ? c!.id : a!.id })
    expect(new Set(w.tasks.list().map((t) => t.rank)).size).toBe(3)
  })

  it('treats an epic as a container: never started, under way once its tasks are', async () => {
    const epic = w.tasks.create({ project: 'shop', title: 'Checkout', brief: 'A new checkout.', tier: 'epic' })
    expect(epic).toMatchObject({ tier: 'epic', status: 'todo', stage: 'backlog', assignee: null, lastRunId: null })
    expect(() => w.tasks.start(epic.id)).toThrow('An epic is not worked on itself. Start the tasks under it.')
    expect(() => w.tasks.create({ project: 'shop', brief: 'Nested.', tier: 'epic', parentId: epic.key })).toThrow('An epic cannot sit under another task.')
    const one = w.tasks.create({ project: 'shop', brief: 'Basket.', parentId: epic.key })
    const two = w.tasks.create({ project: 'shop', brief: 'Payment.', parentId: epic.id, start: false })
    await until(() => status(one.id) === 'done')
    expect(w.tasks.get(epic.id)).toMatchObject({ stage: 'doing', counts: { children: 2, childrenDone: 1 } })
    expect(w.tasks.detail(epic.key)!.children.map((c) => c.key)).toEqual([one.key, two.key])
    expect(w.tasks.detail(two.id)!.parent).toMatchObject({ key: epic.key, title: 'Checkout' })
  })
})

describe('changing a task', () => {
  it('changes only what is sent, and writes each change to the history', () => {
    const t = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Fix the header.', start: false })
    const out = w.tasks.update(t.key, { title: 'Sticky header', priority: 'urgent', labels: ['nav'], dueAt: Date.parse('2026-11-20T12:00:00Z'), assignee: 'Rex', kind: 'review' })
    expect(out).toMatchObject({ title: 'Sticky header', brief: 'Fix the header.', priority: 'urgent', labels: ['nav'], assigneeName: 'Rex', kind: 'review' })
    expect(history(t.id).reverse().slice(1)).toEqual(['You: title Header→Sticky header', 'You: kind other→review', 'You: priority normal→urgent', 'You: labels →nav', 'You: due →2026-11-20', 'You: assignee Ada→Rex'])
    const before = history(t.id).length
    w.tasks.update(t.id, { title: 'Sticky header', priority: 'urgent' })
    expect(history(t.id)).toHaveLength(before)

    expect(() => w.tasks.update(t.id, { title: '  ' })).toThrow('A task needs a title.')
    expect(() => w.tasks.update(t.id, { priority: 'asap' as never })).toThrow('Priority is urgent, high, normal or low.')
    expect(() => w.tasks.update(t.id, { assignee: 'Nobody' })).toThrow('Nobody on the team is called "Nobody".')
    expect(() => w.tasks.update(t.id, { model: 'bad model!' })).toThrow(/can only contain/)
    expect(() => w.tasks.update('SHO-99', { title: 'x' })).toThrow('No such task.')
  })

  it('refuses loops: under itself, or two tasks waiting for each other', () => {
    const a = w.tasks.create({ project: 'shop', brief: 'A', start: false })
    const b = w.tasks.create({ project: 'shop', brief: 'B', start: false, parentId: a.id, dependsOn: [a.id] })
    const c = w.tasks.create({ project: 'shop', brief: 'C', start: false, parentId: b.id, dependsOn: [b.id] })
    expect(() => w.tasks.update(a.id, { parentId: c.key })).toThrow('A task cannot sit under itself, or under one of its own sub-tasks.')
    expect(() => w.tasks.update(a.id, { dependsOn: [c.key] })).toThrow('Two tasks cannot wait for each other.')
    expect(() => w.tasks.update(a.id, { dependsOn: ['SHO-77'] })).toThrow('This task is set to wait for SHO-77, which does not exist.')
    expect(w.tasks.update(c.id, { parentId: null, dependsOn: [] })).toMatchObject({ parentId: null, dependsOn: [] })
    expect(w.tasks.detail(a.id)).toMatchObject({ blocks: [{ key: b.key }], children: [{ key: b.key }] })
  })

  it('starts a waiting task when what it waited for is taken off it', async () => {
    const a = w.tasks.create({ project: 'shop', brief: 'A', start: false })
    const b = w.tasks.create({ project: 'shop', brief: 'B', dependsOn: [a.id] })
    expect(status(b.id)).toBe('queued')
    w.tasks.update(b.id, { dependsOn: [] })
    await until(() => status(b.id) === 'done')
  })

  it('does not change who does it while a worker is on it; afterwards the new one starts fresh, told what came before', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_MODE: 'hang' }
    const t = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Fix the header.' })
    await until(() => status(t.id) === 'running' && w.sup.view(w.tasks.get(t.id)!.lastRunId!)!.status === 'running')
    expect(() => w.tasks.update(t.id, { assignee: 'Rex' })).toThrow('Who does it cannot be changed while a worker is on the task. Stop it first.')
    w.tasks.update(t.id, { priority: 'low' })
    w.tasks.stop(t.id)
    await until(() => status(t.id) === 'cancelled')

    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_ARGS_OUT: join(w.root, 'args.json'), FAKE_STDIN_OUT: join(w.root, 'stdin.txt') }
    w.tasks.update(t.id, { assignee: 'Rex' })
    w.tasks.start(t.id)
    await until(() => status(t.id) === 'done')
    expect(JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))).not.toContain('--resume')
    const told = readFileSync(join(w.root, 'stdin.txt'), 'utf8')
    expect(told).toContain('Task: Header\n\nFix the header.')
    expect(told).toContain('This task was worked on before, in a session you do not have.')
    expect(readFileSync(join(w.home.runs, w.tasks.get(t.id)!.lastRunId!, 'system.md'), 'utf8')).toContain(`Task: ${t.key}`)
    // The next turn is the same session again.
    w.tasks.answer(t.id, 'One more thing.')
    await until(() => w.tasks.runs(t.id).length === 3 && status(t.id) === 'done')
    expect(JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))).toContain('--resume')
  })

  it('deletes only a task no worker ever touched, and leaves nothing waiting for it', async () => {
    const a = w.tasks.create({ project: 'shop', brief: 'A', start: false })
    const b = w.tasks.create({ project: 'shop', brief: 'B', start: false, dependsOn: [a.id] })
    const child = w.tasks.create({ project: 'shop', brief: 'Under A', start: false, parentId: a.id })
    const f = await upload('note.txt', 'hello')
    w.tasks.attach(a.id, [f.id])
    w.tasks.comment(a.id, 'user', 'A thought.')
    expect(() => w.tasks.remove(a.id)).toThrow('This task has tasks under it. Move or delete those first.')
    w.tasks.remove(child.key)
    const gone: string[] = []
    w.bus.on('task-removed', (x) => gone.push(x.id))
    w.tasks.remove(a.id)
    expect(gone).toEqual([a.id])
    expect(w.tasks.get(a.id)).toBeUndefined()
    expect(w.tasks.get(b.id)!.dependsOn).toEqual([])
    expect(existsSync(f.path)).toBe(false)

    const ran = w.tasks.create({ project: 'shop', brief: 'Ran.' })
    await until(() => status(ran.id) === 'done')
    expect(() => w.tasks.remove(ran.id)).toThrow('A worker has been on this task, so it is kept. Close it instead.')
  })
})

describe('comments and files', () => {
  it('tells the worker about the files and comments on its task, each once', async () => {
    const shot = await upload('Screen Shot.png', 'png-bytes', 'image/png')
    const spec = await upload('spec.pdf', 'pdf-bytes', 'application/pdf')
    const t = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Fix the header.', start: false, files: [shot.id] })
    w.tasks.comment(t.id, 'user', 'Check the footer too.', { files: [spec.id] })
    w.tasks.comment(t.id, 'manager', 'Rex reviews it afterwards.')
    expect(w.tasks.get(t.id)!.counts).toMatchObject({ comments: 2, files: 1 })

    const stdin = join(w.root, 'stdin.txt')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_STDIN_OUT: stdin }
    w.tasks.start(t.id)
    await until(() => status(t.id) === 'done')
    const first = readFileSync(stdin, 'utf8')
    expect(first.startsWith('Task: Header\n\nFix the header.\n\nFiles attached to this task (open them when you need them):\n')).toBe(true)
    expect(first).toContain(`- ${shot.path} (picture, 9 B)`)
    expect(shot.path.endsWith('/Screen Shot.png')).toBe(true)
    expect(readFileSync(shot.path, 'utf8')).toBe('png-bytes')
    expect(first).toMatch(/Comments on this task:\n- The owner, \d{4}-\d\d-\d\d \d\d:\d\d: Check the footer too\.\n {2}Attached:\n {2}- .*spec\.pdf \(application\/pdf, 9 B\)\n- The manager, .*: Rex reviews it afterwards\./)

    // A comment sent to the worker is the message itself; a plain one waits for the next turn.
    expect(() => w.tasks.comment(t.id, 'user', '', {})).toThrow('Write a comment first.')
    const later = await upload('more.txt', 'more')
    w.tasks.attach(t.id, [later.id])
    w.tasks.comment(t.id, 'user', 'Not urgent: rename the class.')
    const sent = w.tasks.comment(t.id, 'user', 'Also make it sticky.', { send: true })
    expect(sent).toMatchObject({ sent: true, authorName: 'You' })
    await until(() => w.tasks.runs(t.id).length === 2 && status(t.id) === 'done')
    const second = readFileSync(stdin, 'utf8')
    expect(second.startsWith('Also make it sticky.\n\nFiles attached to this task since your last turn')).toBe(true)
    expect(second).toContain(later.path)
    expect(second).not.toContain(shot.path)
    expect(second).toContain('Comments on this task since your last turn:\n- The owner')
    expect(second).toContain('Not urgent: rename the class.')
    expect(second).not.toContain('Check the footer too.')
    expect(second.match(/Also make it sticky\./g)).toHaveLength(1)

    w.tasks.answer(t.id, 'Thanks.')
    await until(() => w.tasks.runs(t.id).length === 3 && status(t.id) === 'done')
    expect(readFileSync(stdin, 'utf8')).toBe('Thanks.')
    expect(w.tasks.detail(t.id)!.comments.map((c) => [c.authorName, c.sent, c.files.length])).toEqual([['You', false, 1], ['The manager', false, 0], ['You', false, 0], ['You', true, 0]])
  })

  it('will not send a comment to a worker that is busy or was never started', async () => {
    const t = w.tasks.create({ project: 'shop', brief: 'Later.', start: false })
    expect(() => w.tasks.comment(t.id, 'user', 'Go on.', { send: true })).toThrow('That task has not started yet. Start it first.')
    expect(w.tasks.detail(t.id)!.comments).toHaveLength(0)
  })

  it('edits and removes a comment, and lets go of its files', async () => {
    const t = w.tasks.create({ project: 'shop', brief: 'Later.', start: false })
    const f = await upload('a.txt', 'a')
    const c = w.tasks.comment(t.id, 'user', 'Frist', { files: [f.id] })
    expect(w.tasks.editComment(c.id, 'First')).toMatchObject({ text: 'First', editedAt: expect.any(Number) })
    w.tasks.removeComment(c.id)
    expect(w.tasks.detail(t.id)!.comments).toEqual([])
    expect(w.tasks.files.row(f.id)).toBeUndefined()
    expect(existsSync(f.path)).toBe(false)
  })

  it('keeps a file as long as anything holds it, and sweeps up uploads nobody attached', async () => {
    const t = w.tasks.create({ project: 'shop', brief: 'Later.', start: false })
    const f = await upload('shared.txt', 'x')
    const loose = await upload('loose.txt', 'y')
    w.tasks.attach(t.id, [f.id])
    w.tasks.comment(t.id, 'user', 'See file.', { files: [f.path] })
    w.tasks.detach(t.id, f.id)
    expect(existsSync(f.path)).toBe(true)
    expect(w.tasks.files.sweep(-1000)).toBe(1)
    expect(existsSync(loose.path)).toBe(false)
    expect(existsSync(f.path)).toBe(true)
    expect(() => w.tasks.attach(t.id, ['f_000000000000'])).toThrow('There is no uploaded file "f_000000000000".')
    expect(history(t.id).slice(0, 2)).toEqual(['You: file removed shared.txt→', 'You: file added →shared.txt'])
  })

  it('takes any name safely and stops at the size limit', async () => {
    expect(safeName('../../etc/passwd')).toBe('etc passwd')
    expect(safeName('  .hidden<script>.html ')).toBe('hiddenscript.html')
    expect(safeName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(safeName(`${'x'.repeat(300)}.png`)).toHaveLength(120)
    expect(safeName('///')).toBe('file')
    w.tasks.files.maxBytes = 10
    await expect(upload('big.bin', 'x'.repeat(11))).rejects.toThrow('That file is larger than 10 B, the most HeyBotOS takes.')
    await expect(upload('empty.bin', '')).rejects.toThrow('The file arrived empty.')
    expect(w.db.all('select id from files')).toEqual([])
  })
})

describe('links, search and saved filters', () => {
  it('links tasks once, readable from both ends', () => {
    const a = w.tasks.create({ project: 'shop', brief: 'A', start: false })
    const b = w.tasks.create({ project: 'shopfront', brief: 'B', start: false })
    w.tasks.link(a.id, b.key, 'relates')
    w.tasks.link(b.id, a.key, 'relates')
    w.tasks.link(a.id, b.key, 'duplicates')
    expect(w.tasks.detail(a.id)!.links.map((l) => [l.type, l.outward, l.task.key])).toEqual([['relates', true, 'SHOP-1'], ['duplicates', true, 'SHOP-1']])
    expect(w.tasks.detail(b.id)!.links.map((l) => [l.type, l.outward, l.task.key])).toEqual([['relates', false, 'SHO-1'], ['duplicates', false, 'SHO-1']])
    expect(() => w.tasks.link(a.id, a.key, 'relates')).toThrow('A task cannot be linked to itself.')
    expect(() => w.tasks.link(a.id, 'SHO-50', 'relates')).toThrow('There is no task SHO-50.')
    w.tasks.unlink(w.tasks.detail(a.id)!.links[0]!.id)
    expect(w.tasks.detail(b.id)!.links).toHaveLength(1)
  })

  it('finds tasks by key and by words in the title, description, labels, comments and file names', async () => {
    const a = w.tasks.create({ project: 'shop', title: 'Sticky header', brief: 'The nav slides under it.', start: false, labels: ['frontend'] })
    const b = w.tasks.create({ project: 'shop', title: 'Invoice layout', brief: 'Totals are cut off.', start: false })
    w.tasks.comment(b.id, 'user', 'The customer mentioned the header as well.')
    w.tasks.attach(b.id, [(await upload('invoice-100%.pdf', 'x')).id])
    const found = (q: string) => w.tasks.search(q).map((t) => t.key)
    expect(found('header')).toEqual(expect.arrayContaining([a.key, b.key]))
    expect(found('header nav')).toEqual([a.key])
    expect(found('frontend')).toEqual([a.key])
    expect(found('100%')).toEqual([b.key])
    expect(found('sho-2')).toEqual([b.key])
    expect(found('_')).toEqual([])
    expect(found('   ')).toEqual([])
  })

  it('saves a filter under a name, replaces it by name, and removes it', () => {
    w.tasks.saveFilter('Bugs', '?label=bug&stage=backlog')
    const again = w.tasks.saveFilter('bugs', 'label=bug')
    expect(w.tasks.filters()).toEqual([expect.objectContaining({ name: 'Bugs', query: 'label=bug' })])
    expect(() => w.tasks.saveFilter(' ', 'x')).toThrow('Give the filter a name.')
    w.tasks.removeFilter(again.id)
    expect(w.tasks.filters()).toEqual([])
  })
})

describe('over HTTP', () => {
  let app: Hono
  const HOST = '127.0.0.1:4747'
  const headers = () => ({ host: HOST, authorization: `Bearer ${w.home.secret}`, origin: `http://${HOST}` })
  const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...headers(), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  beforeEach(() => {
    const auth = new Auth(w.home, w.db, 4747)
    app = createApp({ home: w.home, bus: w.bus, supervisor: w.sup, registry: w.registry, tasks: w.tasks, approvals: w.approvals, manager: w.manager, router: w.router, routines: w.routines, connectors: w.connectors, gateway: w.gateway, staff: w.staff, settings: w.settings, threads: w.threads, auth, version: 'test' })
  })

  it('creates to the backlog, shows the task by its key, changes, moves and deletes it', async () => {
    const made = await send('POST', '/api/tasks', { project: 'shop', title: 'Header', brief: 'Fix it.', start: false, priority: 'high', labels: ['bug'], dueAt: 1795000000000 })
    expect(made.status).toBe(201)
    const { task } = (await made.json()) as { task: { id: string; key: string } }
    expect(task).toMatchObject({ key: 'SHO-1', stage: 'backlog', priority: 'high', labels: ['bug'], dueAt: 1795000000000 })

    const page = (await (await send('GET', '/api/tasks/sho-1')).json()) as Record<string, unknown>
    expect(Object.keys(page).sort()).toEqual(['blockedBy', 'blocks', 'children', 'comments', 'files', 'history', 'links', 'parent', 'runs', 'task'])
    expect((await send('GET', '/api/tasks/SHO-2')).status).toBe(404)

    const changed = await send('PATCH', '/api/tasks/SHO-1', { title: 'Sticky header', dueAt: null, status: 'done', id: 'x', rank: 1 })
    expect(((await changed.json()) as { task: unknown }).task).toMatchObject({ title: 'Sticky header', dueAt: null, status: 'todo', id: task.id })
    expect(await (await send('PATCH', '/api/tasks/SHO-1', { priority: 'whenever' })).json()).toEqual({ error: 'Priority is urgent, high, normal or low.' })

    expect(((await (await send('POST', '/api/tasks/SHO-1/comments', { text: 'A note.' })).json()) as { comment: unknown }).comment).toMatchObject({ text: 'A note.', author: 'user' })
    expect(((await (await send('GET', '/api/tasks/search?q=sticky')).json()) as { tasks: unknown[] }).tasks).toHaveLength(1)
    expect((await send('POST', '/api/tasks/SHO-1/move', { stage: 'done' })).status).toBe(200)
    expect(w.tasks.get(task.id)).toMatchObject({ status: 'done', closedBy: 'user' })
    expect((await send('DELETE', '/api/tasks/SHO-1')).status).toBe(200)
    expect(w.tasks.get(task.id)).toBeUndefined()

    expect(((await (await send('PUT', '/api/projects/shop', { key: 'web', starred: true })).json()) as { project: unknown }).project).toMatchObject({ key: 'WEB', starred: true })
    expect(((await (await send('POST', '/api/filters', { name: 'Open', query: 'stage=backlog' })).json()) as { filter: unknown }).filter).toMatchObject({ name: 'Open' })
  })

  it('takes an upload, and never hands a file back as something that could run in the page', async () => {
    const put = (name: string, body: string, type: string) => app.request(`/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers(), 'content-type': type }, body })
    const svg = ((await (await put('logo.svg', '<svg onload="alert(1)"/>', 'image/svg+xml')).json()) as { file: { id: string; image: boolean } }).file
    const page = ((await (await put('page.html', '<script>alert(1)</script>', 'text/html')).json()) as { file: { id: string } }).file
    const png = ((await (await put('../shot.png', 'png', 'image/png')).json()) as { file: { id: string; image: boolean; name: string } }).file
    expect(svg.image).toBe(false)
    expect(png).toMatchObject({ image: true, name: 'shot.png' })

    for (const f of [svg, page]) {
      const res = await app.request(`/api/files/${f.id}`, { headers: headers() })
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; /)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    }
    const shown = await app.request(`/api/files/${png.id}`, { headers: headers() })
    expect(shown.headers.get('content-type')).toBe('image/png')
    expect(shown.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png")
    expect(await shown.text()).toBe('png')

    // Not without the owner's session, and not from another site.
    expect((await app.request(`/api/files/${png.id}`, { headers: { host: HOST } })).status).toBe(401)
    expect((await app.request('/api/files?name=x.txt', { method: 'POST', headers: { ...headers(), origin: 'https://elsewhere.example' }, body: 'x' })).status).toBe(403)
    expect((await put('', 'x', 'text/plain')).status).toBe(400)
    expect((await app.request('/api/files/f_000000000000', { headers: headers() })).status).toBe(404)

    const made = await send('POST', '/api/tasks', { project: 'shop', brief: 'With a picture.', start: false, files: [png.id] })
    const { task } = (await made.json()) as { task: { key: string; counts: { files: number } } }
    expect(task.counts.files).toBe(1)
    expect((await send('POST', `/api/tasks/${task.key}/files`, { files: [svg.id] })).status).toBe(200)
    expect((await send('DELETE', `/api/tasks/${task.key}/files/${png.id}`)).status).toBe(200)
    expect(w.tasks.detail(task.key)!.files.map((f) => f.name)).toEqual(['logo.svg'])
  })

  it('passes files in a message on to the manager as paths, and shows them on the message', async () => {
    const file = await upload('brief.pdf', 'pdf', 'application/pdf')
    const stdin = join(w.root, 'manager-stdin.txt')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_STDIN_OUT: stdin }
    const res = await send('POST', '/api/chat', { text: 'Make tasks from this.', files: [file.id] })
    expect(((await res.json()) as { message: unknown }).message).toMatchObject({ text: 'Make tasks from this.', files: [{ id: file.id, name: 'brief.pdf' }] })
    await until(() => existsSync(stdin))
    const heard = readFileSync(stdin, 'utf8')
    expect(heard).toContain('[The owner says]\nMake tasks from this.\n\n[The owner attached a file.')
    expect(heard).toContain(`- ${file.path} (application/pdf, 3 B)`)
    expect(w.manager.state().messages[0]!.files).toHaveLength(1)
    // The manager can put that file on a task by the path it was given.
    const t = w.tasks.create({ project: 'shop', brief: 'From the brief.', start: false, files: [file.path] }, 'manager')
    expect(w.tasks.detail(t.id)!.files.map((f) => f.id)).toEqual([file.id])
    expect((await send('POST', '/api/chat', { text: ' ' })).status).toBe(400)
    // Files alone are a message too, and the list of conversations says what it was.
    const alone = await upload('sketch.png', 'png', 'image/png')
    expect((await send('POST', '/api/chat', { text: '', thread: 'shop', files: [alone.id] })).status).toBe(201)
    expect(w.threads.list('Manager').find((t) => t.id === 'shop')!.lastText).toBe('You: Sent a file')
  })
})
