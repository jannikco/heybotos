// `pnpm smoke`: one short real run per installed engine, in a throwaway folder. Opt-in, because it
// spends a little subscription usage. Set HEYBOTOS_SMOKE_MODEL to pick a small model.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../src/bus.ts'
import { Db } from '../src/db.ts'
import { openHome } from '../src/home.ts'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Approvals } from '../src/approvals.ts'
import { Manager } from '../src/manager.ts'
import { Router } from '../src/router.ts'
import { Routines } from '../src/routines.ts'
import { ConnectorRegistry } from '../src/connect/registry.ts'
import { Gateway } from '../src/connect/gateway.ts'
import { Staff } from '../src/staff.ts'
import { Settings } from '../src/settings.ts'
import { Threads } from '../src/threads.ts'
import { claudeAdapter } from '../src/engines/claude.ts'
import { codexAdapter } from '../src/engines/codex.ts'
import { grokAdapter } from '../src/engines/grok.ts'
import { Supervisor } from '../src/engines/supervisor.ts'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { loadGateConfig } from '../src/policy/gate.ts'
import { Registry } from '../src/registry.ts'
import { Tasks } from '../src/tasks.ts'

const only = process.env.HEYBOTOS_SMOKE_ONLY ?? '' // "basic", "gate", "connect", "trusted" … to run one part
const root = mkdtempSync(join(tmpdir(), 'heybotos-smoke-'))
const work = join(root, 'code', 'smoke-project')
mkdirSync(work, { recursive: true })
const home = openHome(join(root, 'home'))
home.config.keepAwake = false
home.config.projectRoots = [join(root, 'code')]
home.config.engines.claude.model = process.env.HEYBOTOS_SMOKE_MODEL ?? ''
const db = new Db(home.dbPath)
const bus = new Bus()
const sup = new Supervisor(home, db, bus, { claude: claudeAdapter, codex: codexAdapter, grok: grokAdapter })
const registry = new Registry(home, db)
const tasks = new Tasks(home, db, bus, sup, registry)
const gate = loadGateConfig(home)
// A host you already let agents use (HEYBOTOS_SMOKE_ALLOWED_HOST), to prove allowed connections pass.
const allowedHost = process.env.HEYBOTOS_SMOKE_ALLOWED_HOST ?? ''
if (allowedHost) gate.allowedHosts.push(allowedHost)
const approvals = new Approvals(home, db, bus, sup, tasks, gate)
const auth = new Auth(home, db, 0)
const router = new Router(home, db, bus, sup, tasks)
const manager = new Manager(home, db, bus, sup, tasks, registry)
const staff = new Staff(db, manager)
tasks.staff = staff
const connectors = new ConnectorRegistry(home, db)
const gateway = new Gateway(home, db, connectors, approvals)
sup.hubFor = (run) => ({ name: 'hub', url: gateway.urlFor(run.id, approvals.url) })
tasks.checkConnectors = (names) => connectors.check(names)
tasks.connectorsTrusted = (names) => connectors.allTrusted(names)
const app = createApp({ home, bus, supervisor: sup, registry, tasks, approvals, manager, router, routines: new Routines(db, manager), connectors, gateway, staff, settings: new Settings({ home, manager, approvals, router, registry, connectors, supervisor: sup }), threads: new Threads(db, registry), auth, version: 'smoke' })
const server = await new Promise<ServerType>((resolve) => {
  const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s))
})
const port = (server.address() as AddressInfo).port
auth.hosts.add(`127.0.0.1:${port}`)
approvals.url = `http://127.0.0.1:${port}`
manager.url = approvals.url
await registry.scan()
sup.start()

const done = (id: string) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (!['queued', 'starting', 'running', 'stopping'].includes(sup.view(id)!.status)) {
        clearInterval(t)
        resolve()
      }
    }, 200)
  })

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

if (only === '' || only === 'basic') {
const first = sup.create({
  engine: 'claude',
  cwd: work,
  prompt: 'Create a file named hello.txt containing exactly the word hi. Then hand in your report.',
  extra: { systemPrompt: 'House rule for this session: the summary in your report must end with the word PINEAPPLE.', wantReport: true },
})
await done(first.id)
const a = sup.view(first.id)!
const events = sup.events(first.id)
const init = events.find((e) => e.kind === 'phase')
check('claude: run finished as done', a.status === 'done', `${a.status} ${a.error ?? ''}`)
check('claude: used the subscription login and no connectors', init !== undefined && (init.data.connectors as unknown[]).length === 0)
check('claude: did the work', existsSync(join(work, 'hello.txt')) && readFileSync(join(work, 'hello.txt'), 'utf8').trim() === 'hi')
check('claude: handed in a structured report', a.report?.status === 'done', JSON.stringify(a.report))
check('claude: followed the system prompt file', /PINEAPPLE/.test(a.report?.summary ?? ''))
check('claude: the report tool call stays hidden', !events.some((e) => e.kind === 'tool_start' && e.data.name === 'StructuredOutput'))

const second = sup.continue(first.id, 'Without looking at the disk: what was the name of the file you created? Put it in the report summary.')
await done(second.id)
const b = sup.view(second.id)!
check('claude: resumed the same session', b.status === 'done' && b.sessionId === a.sessionId, `${b.status} ${b.error ?? ''}`)
check('claude: remembered the first turn', /hello\.txt/.test(b.report?.summary ?? ''), b.report?.summary)

if (process.env.HEYBOTOS_SMOKE_KEEP) {
  // (fixtures for the test suite)
  mkdirSync(process.env.HEYBOTOS_SMOKE_KEEP, { recursive: true })
  copyFileSync(join(home.runs, first.id, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, 'claude-report.jsonl'))
  copyFileSync(join(home.runs, second.id, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, 'claude-resume.jsonl'))
}
}

if (only === '' || only === 'gate') {
  // The gate, through the real CLI: the hook must stop a connection to a server that is not on the
  // list (the name below can never resolve, so nothing is reached even if the gate were broken).
  const settled = (id: string) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!['todo', 'queued', 'running'].includes(tasks.get(id)!.status)) {
          clearInterval(t)
          resolve()
        }
      }, 200)
    })
  const also = allowedHost ? ` Second: ssh -o BatchMode=yes -o ConnectTimeout=8 ${allowedHost} true` : ''
  const t = tasks.create({
    project: 'smoke-project',
    title: 'Gate check',
    brief: `Run these shell commands exactly as written, each as its own command, and do nothing else. First: ssh heybotos-gate-check.invalid true.${also} Then hand in your report: say for each command whether it ran and its exit code. If a command was refused, follow the instructions in the refusal.`,
  })
  await settled(t.id)
  const task = tasks.get(t.id)!
  const ev = sup.events(task.lastRunId!)
  const results = ev.filter((e) => e.kind === 'tool_result').map((e) => String(e.data.text))
  const pending = approvals.list()
  check('gate: the hook refused the connection and told the worker why', results.some((r) => /needs the owner's approval/.test(r)), results.join(' | ').slice(0, 300))
  check('gate: one request is waiting in the inbox', pending.length === 1 && pending[0]!.kind === 'host' && pending[0]!.summary.includes('heybotos-gate-check.invalid'), JSON.stringify(pending.map((p) => p.summary)))
  check('gate: the worker stopped to wait instead of working around it', task.status === 'needs_input', `${task.status}: ${task.summary}`)
  if (allowedHost) {
    // Judged from the tool result itself, not from how the worker worded its report.
    const call = ev.find((e) => e.kind === 'tool_start' && String((e.data.input as { command?: string }).command ?? '').includes(` ${allowedHost} true`))
    const result = ev.find((e) => e.kind === 'tool_result' && e.data.id === call?.data.id)
    check('gate: a connection to an allowed server went through the wrapper', result !== undefined && result.data.isError !== true, JSON.stringify(result?.data ?? null).slice(0, 200))
  }
  if (process.env.HEYBOTOS_SMOKE_KEEP) copyFileSync(join(home.runs, task.lastRunId!, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, 'claude-gate.jsonl'))
}

if (only === '' || only === 'codex') {
  // A real Codex worker in a task. Codex has no hook, so the gate has to hold through the wrappers
  // on its PATH, inside the login shell Codex runs every command in.
  const settled = (id: string) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!['todo', 'queued', 'running'].includes(tasks.get(id)!.status)) {
          clearInterval(t)
          resolve()
        }
      }, 200)
    })
  const before = approvals.list().length
  const t = tasks.create({
    project: 'smoke-project',
    title: 'Codex check',
    engine: 'codex',
    brief: 'Run these three shell commands exactly as written, each as its own command, and do nothing else. First: command -v ssh. Second: ssh heybotos-codex-check.invalid true. Third: printf codex-was-here > codex.txt. Then hand in your report: quote the output of the first command in the summary, and if a command was refused, follow the instructions in the refusal.',
  })
  await settled(t.id)
  const task = tasks.get(t.id)!
  const ev = sup.events(task.lastRunId!)
  const out = ev.filter((e) => e.kind === 'tool_result').map((e) => String(e.data.text))
  check('codex: ran as a task and handed in a structured report', tasks.runs(t.id)[0]!.report !== null, `${task.status}: ${task.summary}`)
  check('codex: did the work in the project folder', existsSync(join(work, 'codex.txt')) && readFileSync(join(work, 'codex.txt'), 'utf8') === 'codex-was-here')
  check('codex: its shell finds the gate wrapper first, not the real ssh', out.some((o) => o.trim() === join(home.state, 'shims', 'ssh')), out.join(' | ').slice(0, 300))
  check('codex: the wrapper refused the connection and a request was filed', out.some((o) => /needs the owner's approval/.test(o)) && approvals.list().length === before + 1, JSON.stringify(approvals.list().map((a) => a.summary)))
  check('codex: it stopped to wait', task.status === 'needs_input', task.status)
  if (process.env.HEYBOTOS_SMOKE_KEEP) copyFileSync(join(home.runs, task.lastRunId!, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, 'codex-gate.jsonl'))
}

if (only === 'connect') {
  // HeyBotOS's own connectors on a real CLI (HEYBOTOS_SMOKE_ENGINE): a stand-in shop system is set up once
  // in HeyBotOS, and the worker must reach it through the gateway: a read goes through, a change waits.
  const engine = (process.env.HEYBOTOS_SMOKE_ENGINE ?? 'codex') as 'claude' | 'codex' | 'grok'
  const calls = join(root, 'shop-calls.txt')
  connectors.save({ name: 'shop', command: process.execPath, args: [join(import.meta.dirname, '..', 'test', 'fakes', 'fake-connector.mjs')], env: { SHOP_KEY: 'smoke-key-7', FAKE_CONNECTOR_LOG: calls } })
  const settled = (id: string) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!['todo', 'queued', 'running'].includes(tasks.get(id)!.status)) {
          clearInterval(t)
          resolve()
        }
      }, 200)
    })
  const t = tasks.create({
    project: 'smoke-project',
    title: 'Connector check',
    engine,
    connectors: ['shop'],
    brief: 'Use the shop connector. First call its search-orders tool with query "4711" and quote exactly what it returns in your summary. Then call its create-order tool with customer "Acme". If a call is refused, follow the instructions in the refusal. Do nothing else.',
  })
  await settled(t.id)
  const task = tasks.get(t.id)!
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  check(`connect (${engine}): the read reached the connector through the gateway`, log.includes('search-orders'), log || '(the connector was never called)')
  check(`connect (${engine}): the worker got the answer, which only the daemon's key could produce`, JSON.stringify(sup.events(task.lastRunId!)).includes('smoke-key-7') || (task.summary ?? '').includes('smoke-key-7'), task.summary ?? '')
  check(`connect (${engine}): the change did not reach the connector`, !log.includes('create-order'), log)
  check(`connect (${engine}): the change became a request for the owner`, approvals.list().some((a) => a.summary === 'Use shop to create order'), JSON.stringify(approvals.list().map((a) => a.summary)))
  check(`connect (${engine}): the worker stopped to wait`, task.status === 'needs_input', `${task.status}: ${task.summary}`)
  if (process.env.HEYBOTOS_SMOKE_KEEP) copyFileSync(join(home.runs, task.lastRunId!, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, `${engine}-connect.jsonl`))
  if (task.status !== 'needs_input') console.log(readFileSync(join(home.runs, task.lastRunId!, 'stderr.log'), 'utf8').slice(-1500))
}

if (only === 'trusted') {
  // A connector the owner trusts, on a real CLI: the worker must have the connector AND its shell, in
  // the same task. (With a connector that is not trusted it has no shell; the part above covers that.)
  const engine = (process.env.HEYBOTOS_SMOKE_ENGINE ?? 'claude') as 'claude' | 'codex' | 'grok'
  const calls = join(root, 'shop-calls.txt')
  connectors.save({ name: 'shop', command: process.execPath, args: [join(import.meta.dirname, '..', 'test', 'fakes', 'fake-connector.mjs')], env: { SHOP_KEY: 'smoke-key-7', FAKE_CONNECTOR_LOG: calls }, trusted: true })
  const project = registry.get('smoke-project')!
  const t = tasks.create({
    project: 'smoke-project',
    title: 'Trusted connector check',
    engine,
    connectors: ['shop'],
    brief: 'Two steps, nothing else. 1: run this shell command in the project folder: printf shell-ok > proof.txt   2: call the shop connector\'s search-orders tool with query "4711" and quote what it returns in your summary.',
  })
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!['todo', 'queued', 'running'].includes(tasks.get(t.id)!.status)) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
  })
  const task = tasks.get(t.id)!
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  const proof = join(project.path, 'proof.txt')
  check(`trusted (${engine}): the worker ran a command`, existsSync(proof) && readFileSync(proof, 'utf8').includes('shell-ok'), task.summary ?? '')
  check(`trusted (${engine}): and reached the connector in the same task`, log.includes('search-orders'), log || '(the connector was never called)')
  check(`trusted (${engine}): and finished`, task.status === 'done', `${task.status}: ${task.summary}`)
  if (task.status !== 'done') console.log(readFileSync(join(home.runs, task.lastRunId!, 'stderr.log'), 'utf8').slice(-1500))
}

if (only === '' || only === 'manager') {
  // The manager, for real: it must reach its tool server, hand a task to a worker, and report back.
  home.config.manager.model = process.env.HEYBOTOS_SMOKE_MODEL ?? ''
  home.config.manager.batchSeconds = 5
  manager.start()
  const quiet = () =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const open = tasks.list({ open: true }).length
        const c = manager.state()
        if (c.activeRunId === null && c.waitingReports === 0 && open === 0 && tasks.list().some((x) => x.createdBy === 'manager')) {
          clearInterval(t)
          resolve()
        }
      }, 500)
      setTimeout(() => {
        clearInterval(t)
        resolve()
      }, 240_000)
    })
  manager.say('In the project smoke-project, please have a file called from-the-manager.txt created that contains exactly the word hello. Tell me when it is done.')
  await quiet()
  await new Promise((r) => setTimeout(r, 1500))
  const turns = sup.list().filter((r) => r.role === 'manager').reverse()
  const first = turns[0]
  const firstEvents = first ? sup.events(first.id) : []
  const init = firstEvents.find((e) => e.kind === 'phase')
  const handed = tasks.list().filter((x) => x.createdBy === 'manager')
  const chat = manager.state().messages
  check('manager: its session connected to the HeyBotOS tool server', JSON.stringify(init?.data.connectors ?? []).includes('"heybotos"') && JSON.stringify(init?.data.connectors).includes('connected'), JSON.stringify(init?.data.connectors))
  check('manager: it handed out a task through its tools', handed.length >= 1 && firstEvents.some((e) => e.kind === 'tool_start' && e.data.name === 'mcp__heybotos__create_task'), firstEvents.filter((e) => e.kind === 'tool_start').map((e) => e.data.name).join(','))
  check('manager: the worker did the job', existsSync(join(work, 'from-the-manager.txt')) && readFileSync(join(work, 'from-the-manager.txt'), 'utf8').trim() === 'hello', handed.map((t) => `${t.status}: ${t.summary}`).join(' | ').slice(0, 300))
  check('manager: it was woken by the report and took a second turn', turns.length >= 2 && turns[1]!.sessionId === first?.sessionId, `${turns.length} turns`)
  check('manager: it answered in the conversation', chat.some((m) => m.role === 'manager'), chat.map((m) => `${m.role}: ${m.text.slice(0, 160)}`).join(' || '))
  check('manager: it could not edit or run anything itself', !firstEvents.some((e) => e.kind === 'tool_start' && ['Bash', 'Edit', 'Write'].includes(String(e.data.name))))
  console.log('\nThe conversation:\n' + chat.map((m) => `  ${m.role}: ${m.text}`).join('\n'))
  manager.stop()
  if (process.env.HEYBOTOS_SMOKE_KEEP && first) copyFileSync(join(home.runs, first.id, 'stdout.jsonl'), join(process.env.HEYBOTOS_SMOKE_KEEP, 'claude-manager.jsonl'))
}

server.close()
sup.shutdown()
db.close()
console.log(failed ? `\n${failed} check(s) failed. Data kept in ${root}` : '\nAll checks passed.')
process.exit(failed ? 1 : 0)
