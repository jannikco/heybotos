import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { FAKE, FIXTURES, makeWorld, sh, until, variant, type World } from './helpers.ts'

let w: World
const RICH = join(FIXTURES, 'claude-rich.jsonl')
const f = (name: string) => join(w.root, name)
const set = (name: string, value: string) => writeFileSync(f(name), value)
/** Everything the manager was told, one entry per turn. */
const told = () => readFileSync(f('mgr-stdin.txt'), 'utf8').split('\n=====\n').filter((x) => x.trim())
const mgrArgs = (): string[] => JSON.parse(readFileSync(f('mgr-args.json'), 'utf8'))
const managerRuns = () => w.sup.list().filter((r) => r.role === 'manager').reverse()
const messages = () => w.manager.state().messages
/** The task's worker process is up and has produced output (so it has read its settings files). */
const producing = (taskId: string) => until(() => w.sup.view(w.tasks.get(taskId)!.lastRunId ?? '')?.status === 'running', 8000, 'worker to produce output')
const idle = () => until(() => w.manager.state().activeRunId === null && managerRuns().length > 0, 10_000, 'manager to finish its turn')

beforeEach(async () => {
  w = makeWorld()
  // One stand-in CLI for both roles; which fixture and behaviour each gets is read from small files,
  // so a test can change them between turns. Manager turns also log what they were told.
  set('mgr-fixture', RICH)
  set('wrk-fixture', RICH)
  set('wrk-mode', 'ok')
  set('wrk-delay', '0')
  const bin = f('cli.sh')
  writeFileSync(
    bin,
    `#!/bin/sh
case "$PWD" in
  */manager)
    if [ "$1" = "-p" ]; then
      tmp=$(mktemp); cat > "$tmp"; cat "$tmp" >> ${sh(f('mgr-stdin.txt'))}; printf '\\n=====\\n' >> ${sh(f('mgr-stdin.txt'))}
      FAKE_FIXTURE=$(cat ${sh(f('mgr-fixture'))}) FAKE_ARGS_OUT=${sh(f('mgr-args.json'))} exec ${sh(FAKE)} "$@" < "$tmp"
    fi ;;
esac
FAKE_FIXTURE=$(cat ${sh(f('wrk-fixture'))}) FAKE_MODE=$(cat ${sh(f('wrk-mode'))}) FAKE_DELAY_MS=$(cat ${sh(f('wrk-delay'))}) exec ${sh(FAKE)} "$@"
`,
    { mode: 0o755 },
  )
  w.home.config.engines.claude.bin = bin
  w.home.config.engines.claude.env = {}
  for (const name of ['shop', 'blog']) mkdirSync(join(w.root, 'code', name))
  writeFileSync(join(w.root, 'code', 'shop', 'README.md'), 'The web shop for printed things: catalogue, basket and checkout.\n')
  await w.registry.scan()
  w.sup.start()
})
afterEach(() => w.cleanup())

describe('talking to the manager', () => {
  it('starts a session with only read tools and its own tool server, and stores the reply', async () => {
    w.manager.say('Fix the header overlap in the shop.')
    expect(messages().map((m) => [m.role, m.text])).toEqual([['user', 'Fix the header overlap in the shop.']])
    expect(w.manager.state().activeRunId).not.toBeNull()
    await idle()

    const run = managerRuns()[0]!
    expect(run).toMatchObject({ role: 'manager', cwd: w.home.manager, status: 'done' })
    const args = mgrArgs()
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,WebSearch,WebFetch')
    expect(args).toContain('--strict-mcp-config')
    const mcp = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf8'))
    expect(mcp.mcpServers.heybotos).toMatchObject({ type: 'http', url: `${w.manager.url}/mcp`, headers: { Authorization: `Bearer ${w.manager.token()}` } })
    const system = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1]!, 'utf8')
    expect(system).toContain('You are the project manager inside HeyBotOS')
    expect(system).toContain('2 projects are known')

    const turn = told()[0]!
    expect(turn).toContain('[HeyBotOS status,')
    expect(turn).toContain('No open tasks.')
    expect(turn).toContain('[The owner says]\nFix the header overlap in the shop.')
    const reply = messages().at(-1)!
    expect(reply).toMatchObject({ role: 'manager', runId: run.id })
    expect(reply.text).toMatch(/^Fixed\. The nav now follows the real header height/)
  })

  it('continues the same session on the next message', async () => {
    w.manager.say('One.')
    await idle()
    w.manager.say('Two.')
    await until(() => managerRuns().length === 2)
    await idle()
    const [a, b] = managerRuns()
    expect(b!.sessionId).toBe(a!.sessionId)
    expect(b!.turn).toBe(2)
    expect(mgrArgs()).toContain('--resume')
    expect(told()[1]).not.toContain('[The conversation so far')
  })

  it('has a seat of its own when every worker slot is taken', async () => {
    w.home.config.maxWorkers = 1
    set('wrk-mode', 'hang')
    const t = w.tasks.create({ project: 'shop', brief: 'A long job.' })
    await producing(t.id)
    w.manager.say('Are you there?')
    await idle()
    expect(messages().at(-1)!.role).toBe('manager')
    expect(told()[0]).toContain(`- ${t.key} [running] shop: A long job.`)
  })

  it('stays silent in the conversation when it has nothing to report', async () => {
    set('mgr-fixture', variant(w.root, 'quiet', (lines) => lines.map((l) => (l.type === 'result' ? { ...l, result: '(nothing to report)' } : l))))
    w.manager.say('Just checking.')
    await idle()
    expect(messages().map((m) => m.role)).toEqual(['user'])
  })

  it('says so in the conversation when its turn fails, and when you stop it', async () => {
    set('mgr-fixture', variant(w.root, 'limit', (lines) => lines.map((l) => (l.type === 'result' ? { ...l, is_error: true, result: "You've hit your session limit" } : l))))
    w.manager.say('Hello?')
    await idle()
    expect(messages().at(-1)).toMatchObject({ role: 'note', text: expect.stringMatching(/could not finish its turn: You've hit your session limit/) })
    expect(() => w.manager.say('   ')).toThrow(/Write a message first/)
  })

  it('starts a fresh session after enough turns and hands over the conversation so far', async () => {
    w.home.config.manager.rotateAfterTurns = 2
    for (const text of ['First.', 'Second.', 'Third.']) {
      const before = managerRuns().length
      w.manager.say(text)
      await until(() => managerRuns().length === before + 1)
      await idle()
    }
    const runs = managerRuns()
    expect(runs.map((r) => r.turn)).toEqual([1, 2, 1])
    expect(runs[2]!.sessionId).not.toBe(runs[0]!.sessionId)
    const fresh = told()[2]!
    expect(fresh).toContain('[The conversation so far, most recent last]')
    expect(fresh).toContain('Owner: First.')
    expect(fresh).toContain('Owner: Second.')
    expect(fresh.match(/Third\./g)).toHaveLength(1) // the new message is not repeated in the handoff
  })
})

describe('reports from workers', () => {
  it('gathers a burst of finishing workers into one turn', async () => {
    w.home.config.maxWorkers = 3
    set('wrk-delay', '4')
    const ids = Array.from({ length: 12 }, (_, i) => w.tasks.create({ project: i % 2 ? 'shop' : 'blog', title: `Job ${i}`, brief: `Do job ${i}.`, isolation: 'direct' }, 'manager').id)
    await until(() => ids.every((id) => w.tasks.get(id)!.status === 'done'), 30_000)
    await until(() => w.manager.state().activeRunId === null && w.manager.state().waitingReports === 0 && managerRuns().length > 0, 15_000, 'every report to be delivered')
    expect(managerRuns().length).toBeLessThanOrEqual(2)
    const all = told().join('\n')
    for (const id of ids) expect(all).toContain(`Task ${w.tasks.get(id)!.key} "`)
    expect(told()[0]).toContain('[No message from the owner.')
    expect(w.manager.state().waitingReports).toBe(0)
  }, 40_000)

  it('does not wait forever: a report is passed on after the gathering time even if others still work', async () => {
    const done = w.tasks.create({ project: 'shop', title: 'Quick', brief: 'Quick job.' }, 'manager')
    await until(() => w.tasks.get(done.id)!.status === 'done')
    set('wrk-mode', 'hang')
    const slow = w.tasks.create({ project: 'blog', title: 'Slow', brief: 'Slow job.' }, 'manager')
    await producing(slow.id)
    // The first report went out at once (nothing else was working then). Make a second one wait.
    await idle()
    const before = managerRuns().length
    set('wrk-mode', 'ok')
    const third = w.tasks.create({ project: 'shop', title: 'Third', brief: 'Third job.' }, 'manager')
    await until(() => w.tasks.get(third.id)!.status === 'done')
    await new Promise((r) => setTimeout(r, 150))
    expect(managerRuns()).toHaveLength(before) // still gathering: "Slow" is working
    expect(w.manager.state().waitingReports).toBe(1)
    w.manager.tick(Date.now() + 31_000)
    expect(managerRuns()).toHaveLength(before + 1)
  })

  it('never makes the owner wait behind reports', async () => {
    set('wrk-mode', 'hang')
    const slow = w.tasks.create({ project: 'blog', title: 'Slow', brief: 'Slow job.' }, 'manager')
    await producing(slow.id)
    set('wrk-mode', 'ok')
    const quick = w.tasks.create({ project: 'shop', title: 'Quick', brief: 'Quick job.' }, 'manager')
    await until(() => w.tasks.get(quick.id)!.status === 'done')
    expect(managerRuns()).toHaveLength(0)
    w.manager.say('How is it going?')
    await idle()
    const turn = told()[0]!
    expect(turn).toContain(`Task ${quick.key} "Quick" in shop is done.`)
    expect(turn).toContain('[The owner says]\nHow is it going?')
  })

  it('caps turns per hour for reports, but not for the owner', async () => {
    w.home.config.manager.maxTurnsPerHour = 1
    w.manager.say('First.')
    await idle()
    const t = w.tasks.create({ project: 'shop', title: 'Later', brief: 'Later job.' }, 'manager')
    await until(() => w.tasks.get(t.id)!.status === 'done')
    await new Promise((r) => setTimeout(r, 150))
    expect(managerRuns()).toHaveLength(1)
    w.manager.say('Second.')
    await until(() => managerRuns().length === 2)
    await idle()
    expect(told()[1]).toContain(`Task ${t.key} "Later"`)
  })

  it('is only woken by tasks it handed out itself, and passes on questions, blocks and failures', async () => {
    const mine = w.tasks.create({ project: 'shop', brief: 'The owner started this one.' }, 'user')
    await until(() => w.tasks.get(mine.id)!.status === 'done')
    await new Promise((r) => setTimeout(r, 120))
    expect(managerRuns()).toHaveLength(0)

    set('wrk-fixture', variant(w.root, 'ask', (lines) => lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { status: 'needs_input', summary: 'Two ways.', question: 'Sticky or static?' } } : l))))
    const q = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Rework it.' }, 'manager')
    await until(() => managerRuns().length === 1)
    await idle()
    expect(told()[0]).toContain(`Task ${q.key} "Header" in shop stopped to ask: Sticky or static?`)
    expect(told()[0]).toContain(`- ${q.key} [needs_input] shop: Header`)

    set('wrk-mode', 'crash')
    const bad = w.tasks.create({ project: 'blog', title: 'Broken', brief: 'Crash.' }, 'manager')
    await until(() => managerRuns().length === 2)
    await idle()
    expect(told()[1]).toMatch(new RegExp(`Task ${bad.key} "Broken" in blog failed\\. The claude process ended without a result`))
  })
})

describe('conversations', () => {
  it('answers in the conversation it was spoken to in, and tells the manager which project that is', async () => {
    w.manager.say('How is the shop doing?', 'shop')
    await idle()
    expect(told()[0]).toContain('[This turn is in the conversation for the project "shop" (id shop, folder ')
    expect(w.manager.state('shop').messages.map((m) => [m.role, m.thread])).toEqual([['user', 'shop'], ['manager', 'shop']])
    expect(w.manager.state('chief').messages).toEqual([])
    w.manager.say('And overall?')
    await until(() => managerRuns().length === 2)
    await idle()
    expect(told()[1]).toContain('[This turn is in the general conversation')
    expect(w.manager.state('chief').messages.map((m) => m.role)).toEqual(['user', 'manager'])
    expect(() => w.manager.say('x', 'no-such-project')).toThrow(/does not exist/)
  })

  it("puts a worker's report, and the manager's answer to it, in that project's conversation", async () => {
    const t = w.tasks.create({ project: 'blog', title: 'Tidy the drafts', brief: 'Tidy.' }, 'manager')
    await until(() => w.tasks.get(t.id)!.status === 'done')
    await until(() => managerRuns().length === 1)
    await idle()
    expect(told()[0]).toContain('the conversation for the project "blog"')
    expect(w.manager.state('blog').messages.map((m) => m.role)).toEqual(['manager'])
  })

  it('lists conversations with what is new since the owner last looked', async () => {
    expect(w.threads.list('Chief of Staff').map((t) => t.id)).toEqual(['chief']) // nothing has happened in any project yet
    const t = w.tasks.create({ project: 'shop', title: 'Fix header', brief: 'Fix.' }, 'user')
    await until(() => w.tasks.get(t.id)!.status === 'done')
    w.manager.say('Thanks. Anything else there?', 'shop')
    await idle()
    const [chief, shop] = w.threads.list('Chief of Staff')
    expect(chief).toMatchObject({ id: 'chief', name: 'Chief of Staff', unread: 0 })
    expect(shop).toMatchObject({ id: 'shop', name: 'shop', kind: 'code', unread: 2, working: 0, needsYou: 0 }) // one finished task, one reply
    expect(shop!.lastText).toMatch(/^Fixed\. The nav now follows/)
    w.threads.markRead('shop')
    expect(w.threads.list('x')[1]!.unread).toBe(0)
  })
})

describe("the manager's tool server", () => {
  let app: Hono
  const HOST = '127.0.0.1:4747'
  let n = 0
  async function rpc(method: string, params?: unknown, token = w.manager.token()) {
    const res = await app.request('/mcp', { method: 'POST', headers: { host: HOST, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })
    return { status: res.status, body: (await res.json().catch(() => null)) as any }
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const { body } = await rpc('tools/call', { name, arguments: args })
    const text = body.result.content[0].text as string
    return { isError: body.result.isError === true, text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }

  beforeEach(() => {
    app = createApp({ home: w.home, bus: w.bus, supervisor: w.sup, registry: w.registry, tasks: w.tasks, approvals: w.approvals, manager: w.manager, router: w.router, routines: w.routines, connectors: w.connectors, gateway: w.gateway, staff: w.staff, settings: w.settings, threads: w.threads, auth: new Auth(w.home, w.db, 4747), version: 'test' })
  })

  it('speaks MCP: initialize, list tools, ignore notifications, and nothing without the token', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'heybotos' } })
    const list = await rpc('tools/list')
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_projects', 'get_project', 'create_project', 'update_project_notes', 'create_task', 'list_tasks', 'get_task', 'get_task_log', 'message_task', 'start_task', 'update_task', 'move_task', 'comment_task', 'link_tasks', 'search_tasks', 'stop_task', 'list_team', 'save_team_member', 'get_settings', 'change_settings', 'set_server_access', 'create_routine', 'list_routines', 'delete_routine', 'set_your_name', 'save_owner_notes'])
    for (const t of list.body.result.tools) expect(t.inputSchema.type, t.name).toBe('object')

    const note = await app.request('/mcp', { method: 'POST', headers: { host: HOST, authorization: `Bearer ${w.manager.token()}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect(note.status).toBe(202)
    expect((await rpc('tools/list', undefined, 'wrong')).status).toBe(401)
    expect((await rpc('tools/list', undefined, w.home.secret)).status).toBe(401) // the owner's secret is not the manager's token
    expect((await app.request('/mcp', { headers: { host: HOST } })).status).toBe(405)
    expect((await rpc('nope')).body.error.code).toBe(-32601)
  })

  it('finds projects by search words and explains a wrong name in words', async () => {
    expect((await call('list_projects')).data).toMatchObject({ total: 2 })
    const hit = (await call('list_projects', { query: 'printed checkout' })).data
    expect(hit.projects).toEqual([expect.objectContaining({ project: 'shop', about: expect.stringContaining('web shop') })])
    const miss = await call('get_project', { project: 'webshop-2' })
    expect(miss.isError).toBe(true)
    expect(miss.text).toMatch(/No project called "webshop-2"\. Use list_projects/)
  })

  it('hands out tasks with dependencies, reads results, and messages a worker', async () => {
    const build = (await call('create_task', { project: 'shop', title: 'Fix header', brief: 'Fix the overlap. Done when the header tests pass.', kind: 'build' })).data
    expect(build).toMatchObject({ created: true, project: 'shop', title: 'Fix header', kind: 'build' })
    const review = (await call('create_task', { project: 'shop', title: 'Review header fix', brief: 'Read the change.', kind: 'review', depends_on: [build.task_id] })).data
    expect(review).toMatchObject({ status: 'queued', depends_on: [build.task_id], waiting_for: expect.stringMatching(/Waiting for "Fix header"/) })
    expect(w.tasks.get(build.task_id)!.createdBy).toBe('manager')

    await until(() => w.tasks.get(review.task_id)!.status === 'done')
    const got = (await call('get_task', { task_id: build.task_id })).data
    expect(got).toMatchObject({ status: 'done', turns: 1, report: { status: 'done', verification: expect.stringContaining('header tests') } })
    const log = (await call('get_task_log', { task_id: build.task_id, last: 5 })).data
    expect(log.lines).toHaveLength(5)
    expect(log.lines.join('\n')).toContain('did: Run the header tests again')

    expect((await call('message_task', { task_id: build.task_id, message: 'Also check the footer.' })).data).toMatchObject({ sent: true })
    await until(() => w.tasks.runs(build.task_id).length === 2 && w.tasks.get(build.task_id)!.status === 'done')
    expect((await call('list_tasks', { which: 'all' })).data.count).toBe(2)
    expect((await call('list_tasks')).data.count).toBe(0)
    expect((await call('create_task', { project: 'shop', title: 'x' })).text).toBe('"brief" is required.')
    expect((await call('get_task', { task_id: 't_nope' })).text).toMatch(/No task "t_nope"/)
  })

  it('takes a new name from the owner, shows it everywhere, and knows it on the next turn', async () => {
    const renamed: string[] = []
    w.bus.on('identity', (i) => renamed.push(i.managerName))
    expect(((await (await app.request('/api/me', { headers: { host: HOST, authorization: `Bearer ${w.home.secret}` } })).json()) as { managerName: string }).managerName).toBe('Manager')
    expect((await call('set_your_name', { name: '  Chief  of Staff ' })).data).toEqual({ renamed: true, name: 'Chief of Staff' })
    expect(renamed).toEqual(['Chief of Staff'])
    expect(((await (await app.request('/api/me', { headers: { host: HOST, authorization: `Bearer ${w.home.secret}` } })).json()) as { managerName: string }).managerName).toBe('Chief of Staff')
    expect((await call('set_your_name', { name: '   ' })).isError).toBe(true)
    w.manager.say('Who are you?')
    await idle()
    expect(told().at(-1)).toContain('The owner calls you: Chief of Staff.')
    const put = await app.request('/api/identity', { method: 'PUT', headers: { host: HOST, authorization: `Bearer ${w.home.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ managerName: 'Ada' }) })
    expect(await put.json()).toEqual({ managerName: 'Ada' })
  })

  it('keeps notes: for a project, for the owner, and adds non-code projects', async () => {
    await call('update_project_notes', { project: 'shop', notes: 'Live site is on web1. Never deploy on Fridays.' })
    expect(w.registry.get('shop')!.notes).toBe('Live site is on web1. Never deploy on Fridays.')
    await call('save_owner_notes', { notes: 'Prefers short answers in Danish.' })
    expect(readFileSync(join(w.home.manager, 'owner-notes.md'), 'utf8')).toBe('Prefers short answers in Danish.')
    expect((await call('create_project', { name: 'Tax return 2026', description: 'Papers and deadlines.' })).data).toMatchObject({ project: 'tax-return-2026', kind: 'other' })

    w.manager.say('Hello.')
    await idle()
    const system = readFileSync(mgrArgs()[mgrArgs().indexOf('--append-system-prompt-file') + 1]!, 'utf8')
    expect(system).toContain('Your notes about the owner from earlier sessions:\nPrefers short answers in Danish.')
  })
})
