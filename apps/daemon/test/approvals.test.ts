import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { FAKE, FIXTURES, firstOnPath, git, makeWorld, scriptEnv, sh, standIn, until, variant, type World } from './helpers.ts'

let w: World
let server: ServerType
let savedPath: string
let asking: string
const HOOK = join(import.meta.dirname, '..', 'hooks', 'gate-hook.mjs')
const sshCalls = () => (existsSync(join(w.root, 'ssh-calls.txt')) ? readFileSync(join(w.root, 'ssh-calls.txt'), 'utf8').trim().split(/\r?\n/) : [])
const status = (id: string) => w.tasks.get(id)!.status

/** Run the real hook script the way the CLI would: tool call on stdin, gate settings in the environment. */
function hook(runId: string, tool: string, input: unknown, env: Record<string, string> = {}): Promise<{ allowed: boolean; reason: string }> {
  return new Promise((resolve) => {
    // Not spawnSync: the daemon it calls lives in this process and must be free to answer.
    const child = spawn(process.execPath, [HOOK], {
      env: { ...scriptEnv(), HEYBOTOS_RUN_ID: runId, HEYBOTOS_GATE_URL: w.approvals.url, HEYBOTOS_GATE_TOKEN: w.approvals.token(runId), ...env },
    })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('exit', (code) => {
      const out = stdout.trim() ? (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput : null
      resolve({ allowed: code === 0 && out === null, reason: out?.permissionDecisionReason ?? '' })
    })
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }))
  })
}

function worker(script: string, fixture: string): void {
  const bin = join(w.root, 'worker.sh')
  writeFileSync(bin, `#!/bin/sh\n${script}\nexec ${sh(FAKE)} "$@"\n`, { mode: 0o755 })
  w.home.config.engines.claude.bin = bin
  w.home.config.engines.claude.env = { FAKE_FIXTURE: fixture, FAKE_STDIN_OUT: join(w.root, 'stdin.txt'), FAKE_ENV_OUT: join(w.root, 'env.json') }
}

beforeEach(async () => {
  w = makeWorld()
  w.approvals.cfg.allowedHosts.push('buildbox')
  const auth = new Auth(w.home, w.db, 0)
  const app = createApp({ home: w.home, bus: w.bus, supervisor: w.sup, registry: w.registry, tasks: w.tasks, approvals: w.approvals, manager: w.manager, router: w.router, routines: w.routines, connectors: w.connectors, gateway: w.gateway, staff: w.staff, settings: w.settings, threads: w.threads, auth, version: 'test' })
  // The hook and the wrappers talk to the daemon over real HTTP, on whatever port is free.
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  auth.hosts.add(`127.0.0.1:${port}`)
  w.approvals.url = `http://127.0.0.1:${port}`

  // A stand-in for the real ssh further down the PATH: it only notes that it was reached.
  standIn(join(w.root, 'bin'), 'ssh', join(w.root, 'ssh-calls.txt'))
  savedPath = process.env.PATH!
  process.env.PATH = `${join(w.root, 'bin')}${delimiter}${savedPath}`

  mkdirSync(join(w.root, 'code', 'shop'))
  git(join(w.root, 'code', 'shop'), 'init', '-q')
  await w.registry.scan()
  asking = variant(w.root, 'asking', (lines) =>
    lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { status: 'needs_input', summary: 'Built it; the upload is waiting for approval.', question: 'May I connect to web1 to upload the build?' } } : l)),
  )
  w.sup.start()
})
afterEach(() => {
  process.env.PATH = savedPath
  server.close()
  w.cleanup()
})

describe('every worker is wired to the gate', () => {
  it('gets the hook (failing closed), the wrappers first on its PATH, and a token of its own', async () => {
    worker('', join(FIXTURES, 'claude-rich.jsonl'))
    const t = w.tasks.create({ project: 'shop', brief: 'Anything.' })
    await until(() => status(t.id) === 'done')
    const runId = w.tasks.get(t.id)!.lastRunId!
    const settings = JSON.parse(readFileSync(join(w.home.runs, runId, 'settings.json'), 'utf8'))
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash|mcp__.*', hooks: [{ type: 'command', onFailure: 'block' }] })
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('gate-hook')
    const env = JSON.parse(readFileSync(join(w.root, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.PATH).toMatch(firstOnPath(join(w.home.state, 'shims')))
    expect(env.HEYBOTOS_GATE_TOKEN).toBe(w.approvals.token(runId))
    expect(w.approvals.verify(runId, env.HEYBOTOS_GATE_TOKEN!)).toBe(true)
    expect(w.approvals.verify('r_other', env.HEYBOTOS_GATE_TOKEN!)).toBe(false)
  })
})

describe('the hook', () => {
  let runId: string
  beforeEach(async () => {
    worker('', join(FIXTURES, 'claude-rich.jsonl'))
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_MODE: 'hang' }
    const t = w.tasks.create({ project: 'shop', title: 'Ship the new header', brief: 'Build and upload.' })
    await until(() => status(t.id) === 'running')
    runId = w.tasks.get(t.id)!.lastRunId!
  })

  it('lets ordinary commands and read-only connector calls through without a trace', async () => {
    expect((await hook(runId, 'Bash', { command: 'pnpm test && git status' })).allowed).toBe(true)
    expect((await hook(runId, 'Bash', { command: 'ssh buildbox uptime' })).allowed).toBe(true)
    expect((await hook(runId, 'mcp__printshop__search-orders', { date: '2026-11-11' })).allowed).toBe(true)
    expect(w.approvals.list('all')).toEqual([])
  })

  it('stops a connection to a server that is not on the list and files one request for it', async () => {
    const first = await hook(runId, 'Bash', { command: 'rsync -a dist/ deploy@web1:/var/www/site/' })
    expect(first.allowed).toBe(false)
    expect(first.reason).toMatch(/needs the owner's approval/)
    expect(first.reason).toMatch(/status needs_input/)
    await hook(runId, 'Bash', { command: 'ssh web1 "systemctl reload php"' }) // same server: same request
    const pending = w.approvals.list()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'host', summary: 'Connect to the server web1', title: 'Ship the new header', projectName: 'shop', status: 'pending' })
    expect(pending[0]!.detail).toContain('rsync -a dist/')
  })

  it('holds a connector call that changes something, and a yes covers exactly that call once', async () => {
    const call = { invoice_id: 4711 }
    expect((await hook(runId, 'mcp__printshop__ledger-export-invoice', call)).allowed).toBe(false)
    const [req] = w.approvals.list()
    expect(req).toMatchObject({ kind: 'tool', summary: 'Use printshop to ledger export invoice' })
    w.approvals.decideApproval(req!.id, true)
    expect((await hook(runId, 'mcp__printshop__ledger-export-invoice', { invoice_id: 9999 })).allowed).toBe(false) // a different invoice
    expect((await hook(runId, 'mcp__printshop__ledger-export-invoice', call)).allowed).toBe(true)
    expect((await hook(runId, 'mcp__printshop__ledger-export-invoice', call)).allowed).toBe(false) // used up
  })

  it('remembers a no, and tells the worker not to look for another way', async () => {
    await hook(runId, 'Bash', { command: 'vercel --prod' })
    w.approvals.decideApproval(w.approvals.list()[0]!.id, false, 'Not before Monday.')
    const again = await hook(runId, 'Bash', { command: 'vercel --prod' })
    expect(again.allowed).toBe(false)
    expect(again.reason).toMatch(/the owner said no/)
    expect(again.reason).toContain('Not before Monday.')
    expect(w.approvals.list()).toEqual([])
    expect(() => w.approvals.decideApproval(w.approvals.list('all')[0]!.id, true)).toThrow(/already been decided/)
  })

  it('lets the owner allow a server for good from the request itself', async () => {
    await hook(runId, 'Bash', { command: 'ssh web1 uptime' })
    const [req] = w.approvals.list()
    w.approvals.decideApproval(req!.id, true, '', true)
    expect(w.approvals.cfg.allowedHosts).toContain('web1')
    expect(w.settings.read().gate.allowedHosts).toContain('web1')
    expect((await hook(runId, 'Bash', { command: 'scp build.tgz web1:/tmp/' })).allowed).toBe(true)
    expect(w.approvals.list()).toEqual([]) // no new request: the server is on the list now
    await hook(runId, 'mcp__shopsystem__create-invoice', { id: 1 })
    expect(() => w.approvals.decideApproval(w.approvals.list()[0]!.id, true, '', true)).toThrow(/Only a server can be allowed for good/)
  })

  it('fails closed: no daemon, a wrong token or missing settings all stop the call', async () => {
    expect((await hook(runId, 'Bash', { command: 'ls' }, { HEYBOTOS_GATE_URL: 'http://127.0.0.1:9' })).reason).toMatch(/daemon is not answering/)
    expect((await hook(runId, 'Bash', { command: 'ls' }, { HEYBOTOS_GATE_TOKEN: 'forged' })).reason).toMatch(/could not prove who it is/)
    expect((await hook(runId, 'Bash', { command: 'ls' }, { HEYBOTOS_GATE_URL: '' })).reason).toMatch(/without its gate settings/)
    expect((await hook('r_unknown', 'Bash', { command: 'ls' })).allowed).toBe(false)
  })
})

describe('from request to resumed worker', () => {
  it('blocks ssh to a gated server, asks the owner, and resumes the same session once they say yes', async () => {
    worker(`ssh web1 uptime 2>>${sh(join(w.root, 'worker.err'))}; echo "exit=$?" >> ${sh(join(w.root, 'worker.log'))}; ssh buildbox uptime`, asking)
    const t = w.tasks.create({ project: 'shop', title: 'Upload the build', brief: 'Build and upload to web1.' })
    await until(() => status(t.id) === 'needs_input')

    expect(sshCalls()).toEqual(['buildbox uptime']) // the allowed server was reached, the gated one was not
    expect(readFileSync(join(w.root, 'worker.log'), 'utf8')).toBe('exit=126\n')
    expect(readFileSync(join(w.root, 'worker.err'), 'utf8')).toMatch(/needs the owner's approval/)
    const [req] = w.approvals.list()
    expect(req).toMatchObject({ kind: 'host', summary: 'Connect to the server web1', taskId: t.id, title: 'Upload the build' })

    w.approvals.decideApproval(req!.id, true, 'Go ahead.')
    await until(() => w.tasks.runs(t.id).length === 2 && status(t.id) === 'needs_input')
    expect(sshCalls()).toEqual(['buildbox uptime', 'web1 uptime', 'buildbox uptime'])
    const runs = w.tasks.runs(t.id)
    expect(runs[1]!.sessionId).toBe(runs[0]!.sessionId)
    const told = readFileSync(join(w.root, 'stdin.txt'), 'utf8')
    expect(told).toContain('The owner has decided:')
    expect(told).toContain('Allowed for the next 15 minutes: Connect to the server web1 (Go ahead.)')
    expect(w.approvals.list()).toEqual([])
  })

  it('resumes the worker with a no as well, and the wrapper keeps refusing', async () => {
    worker(`ssh web1 uptime 2>/dev/null; echo "exit=$?" >> ${sh(join(w.root, 'worker.log'))}`, asking)
    const t = w.tasks.create({ project: 'shop', brief: 'Upload to web1.' })
    await until(() => status(t.id) === 'needs_input')
    w.approvals.decideApproval(w.approvals.list()[0]!.id, false, 'Use staging instead.')
    await until(() => w.tasks.runs(t.id).length === 2 && status(t.id) === 'needs_input')
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toContain('Not allowed: Connect to the server web1 (Use staging instead.)')
    expect(readFileSync(join(w.root, 'worker.log'), 'utf8')).toBe('exit=126\nexit=126\n')
    expect(sshCalls()).toEqual([])
  })

  it('tells a worker that reported done anyway, when the yes came while it was still working', async () => {
    worker('ssh web1 true 2>/dev/null', join(FIXTURES, 'claude-rich.jsonl'))
    w.home.config.engines.claude.env = { ...w.home.config.engines.claude.env, FAKE_DELAY_MS: '20' }
    const t = w.tasks.create({ project: 'shop', brief: 'Upload, or not.' })
    await until(() => w.approvals.list().length === 1)
    w.approvals.decideApproval(w.approvals.list()[0]!.id, true)
    expect(status(t.id)).toBe('running')
    await until(() => w.tasks.runs(t.id).length === 2 && status(t.id) === 'done')
    expect(sshCalls()).toEqual(['web1 true'])
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toContain('Allowed for the next 15 minutes')
    // Told once, not on every later turn.
    await new Promise((r) => setTimeout(r, 200))
    expect(w.tasks.runs(t.id)).toHaveLength(2)
  })

  it('waits to resume until the worker has stopped, and until every request has an answer', async () => {
    worker('ssh web1 true 2>/dev/null; ssh web2 true 2>/dev/null', asking)
    w.home.config.engines.claude.env = { ...w.home.config.engines.claude.env, FAKE_DELAY_MS: '25' }
    const t = w.tasks.create({ project: 'shop', brief: 'Two servers.' })
    await until(() => w.approvals.list().length === 2)
    const [a, b] = w.approvals.list()
    w.approvals.decideApproval(a!.id, true) // decided while the worker is still busy
    await until(() => status(t.id) === 'needs_input')
    await new Promise((r) => setTimeout(r, 150))
    expect(w.tasks.runs(t.id)).toHaveLength(1) // one request is still open
    w.approvals.decideApproval(b!.id, false)
    await until(() => w.tasks.runs(t.id).length === 2 && status(t.id) === 'needs_input')
    const told = readFileSync(join(w.root, 'stdin.txt'), 'utf8')
    expect(told).toMatch(/Allowed for the next 15 minutes: Connect to the server web[12]/)
    expect(told).toMatch(/Not allowed: Connect to the server web[12]/)
  })
})
