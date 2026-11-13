import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { HttpClient } from '../src/connect/client.ts'
import { connectorName } from '../src/connect/registry.ts'
import { watchInbox } from '../src/notify.ts'
import { FIXTURES, makeWorld, until, variant, type World } from './helpers.ts'

const FAKE_CONNECTOR = join(dirname(fileURLToPath(import.meta.url)), 'fakes', 'fake-connector.mjs')

let w: World
let server: ServerType
let base: string
beforeEach(async () => {
  w = makeWorld()
  mkdirSync(join(w.root, 'code', 'shop'))
  await w.registry.scan()
  w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_ARGS_OUT: join(w.root, 'args.json') }
  const auth = new Auth(w.home, w.db, 0)
  const app = createApp({ home: w.home, bus: w.bus, supervisor: w.sup, registry: w.registry, tasks: w.tasks, approvals: w.approvals, manager: w.manager, router: w.router, routines: w.routines, connectors: w.connectors, gateway: w.gateway, staff: w.staff, settings: w.settings, threads: w.threads, auth, version: 'test' })
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve())
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  auth.hosts.add(base.slice(7))
  w.approvals.url = base
  w.sup.start()
})
afterEach(async () => {
  w.connectors.close()
  await new Promise((r) => server.close(r))
  w.cleanup()
})

/** A connector that is a program on this machine: the fake shop system. */
function addShop(): void {
  w.connectors.save({ name: 'shop', command: process.execPath, args: [FAKE_CONNECTOR], env: { ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), SHOP_KEY: 'shop-secret', FAKE_CONNECTOR_LOG: join(w.root, 'shop-calls.txt') } })
}

/** One MCP request to the gateway, the way a worker's CLI sends it. */
async function rpc(url: string, method: string, params: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** A task that stays at work until the test is over, and the address its worker was given. */
async function workingTask(connectors: string[], engine: 'claude' | 'codex' | 'grok' = 'claude'): Promise<{ id: string; runId: string; url: string }> {
  w.home.config.engines[engine].env = { ...w.home.config.engines[engine].env, FAKE_MODE: 'hang', FAKE_ARGS_OUT: join(w.root, 'args.json') }
  const t = w.tasks.create({ project: 'shop', brief: 'Look up order 4711.', connectors, engine })
  await until(() => w.sup.view(w.tasks.get(t.id)!.lastRunId ?? '')?.status === 'running' && existsSync(join(w.root, 'args.json')))
  const runId = w.tasks.get(t.id)!.lastRunId!
  return { id: t.id, runId, url: w.gateway.urlFor(runId, base) }
}

describe("HeyBotOS's own connectors", () => {
  it('starts from the ones Claude Code has, once, and never shows a key', () => {
    expect(w.connectors.names()).toEqual(['memory', 'shopsystem'])
    const list = w.connectors.list()
    expect(list.find((c) => c.name === 'shopsystem')).toMatchObject({ transport: 'http', where: 'https://shop.example', source: 'from Claude Code', enabled: true })
    expect(list.find((c) => c.name === 'memory')).toMatchObject({ transport: 'stdio', where: 'memory-server' })
    expect(JSON.stringify(list)).not.toContain('shop-secret')
    expect(JSON.stringify(w.settings.read())).not.toContain('shop-secret')

    w.connectors.remove('memory')
    w.connectors.importOnce() // a second start does not bring back what the owner removed
    expect(w.connectors.names()).toEqual(['shopsystem'])
    expect(w.connectors.importFromClaude()).toEqual({ added: ['memory'], skipped: ['shopsystem'] })
  })

  it('checks what the owner types in', () => {
    // A name may be typed with spaces or anything else: it is kept in the form every engine takes.
    expect(w.connectors.save({ name: '  My shop (prod) ', url: 'https://x.example/mcp' }).name).toBe('My-shop-prod')
    expect(w.connectors.save({ name: 'my shop', url: 'https://x.example/mcp' }).name).toBe('my-shop')
    expect(connectorName('my--shop')).toBe('my-shop')
    expect(connectorName('my__shop_')).toBe('my_shop')
    expect(connectorName('Blå køer & æbler')).toBe('Blaa-koeer-aebler')
    expect(connectorName('café – crm')).toBe('cafe-crm')
    expect(connectorName(`${'a'.repeat(39)} b c`)).toBe('a'.repeat(39))
    expect(() => w.connectors.save({ name: ' ?! ', url: 'https://x.example/mcp' })).toThrow(/at least one letter or digit/)
    w.connectors.remove('My-shop-prod')
    w.connectors.remove('my-shop')
    expect(() => w.connectors.save({ name: 'hub', url: 'https://x.example/mcp' })).toThrow(/HeyBotOS uses itself/)
    expect(() => w.connectors.save({ name: 'crm' })).toThrow(/needs a web address, or a command/)
    expect(() => w.connectors.save({ name: 'crm', url: 'ftp://x.example' })).toThrow(/must start with http/)
    expect(statSync(w.home.dbPath).mode & 0o077).toBe(0) // keys live in the database: owner only
  })

  it('asks a connector what it offers and remembers the answer, or why it could not', async () => {
    addShop()
    expect(await w.connectors.refresh('shop')).toMatchObject({ tools: ['search-orders', 'create-order'], asks: ['create-order'], error: null })
    expect((await w.connectors.refresh('memory')).error).toMatch(/could not be started|stopped/)
    w.connectors.setEnabled('shop', false)
    expect(w.connectors.names()).not.toContain('shop')
    expect(() => w.tasks.create({ project: 'shop', brief: 'x', connectors: ['shop'] })).toThrow(/No connector called "shop"/)
  })
})

describe('the gateway', () => {
  it('offers a worker exactly the connectors its task was given, under their own names', async () => {
    addShop()
    const t = await workingTask(['shop'])
    const list = await rpc(t.url, 'tools/list')
    expect(list.body.result.tools.map((x: { name: string }) => x.name)).toEqual(['shop--search-orders', 'shop--create-order'])
    expect((await rpc(t.url, 'initialize', { protocolVersion: '2025-06-18' })).body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'heybotos-connect' } })

    // A read goes straight to the connector, which holds the key the worker never sees.
    const read = await rpc(t.url, 'tools/call', { name: 'shop--search-orders', arguments: { query: '4711' } })
    expect(read.body.result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Order 4711 for shop-secret' }] })
    // A connector the task was not given does not exist for this worker.
    const other = await rpc(t.url, 'tools/call', { name: 'shopsystem--search-orders', arguments: {} })
    expect(other.body.result.isError).toBe(true)
    expect(other.body.result.content[0].text).toMatch(/not given a connector called "shopsystem"/)
  })

  it('holds a call that changes something until the owner says yes, then lets it through once', async () => {
    addShop()
    const t = await workingTask(['shop'])
    const call = () => rpc(t.url, 'tools/call', { name: 'shop--create-order', arguments: { customer: 'Acme' } })
    const held = await call()
    expect(held.body.result.isError).toBe(true)
    expect(held.body.result.content[0].text).toMatch(/needs the owner's approval/)
    expect(existsSync(join(w.root, 'shop-calls.txt'))).toBe(false)
    const [request] = w.approvals.list()
    expect(request).toMatchObject({ kind: 'tool', summary: 'Use shop to create order', taskId: t.id })
    await call()
    expect(w.approvals.list()).toHaveLength(1) // asking again does not file it twice

    w.approvals.decideApproval(request!.id, true)
    expect((await call()).body.result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Created an order for Acme' }] })
    expect(readFileSync(join(w.root, 'shop-calls.txt'), 'utf8').trim().split('\n')).toEqual(['create-order {"customer":"Acme"}'])
    expect((await call()).body.result.isError).toBe(true) // one yes, one call
  })

  it("does not ask twice when Claude's own hook sees the same call first", async () => {
    addShop()
    const t = await workingTask(['shop'])
    expect(w.approvals.check(t.runId, 'mcp__hub__shop--create-order', { customer: 'Acme' })).toEqual({ decision: 'allow' })
    expect(w.approvals.list()).toHaveLength(0)
  })

  it('turns away a pass that is made up, belongs to nobody, or whose run is over', async () => {
    addShop()
    expect((await rpc(`${base}/connect/nonsense`, 'tools/list')).status).toBe(401)
    expect((await rpc(`${base}/connect/r_nobody.${'0'.repeat(64)}`, 'tools/list')).status).toBe(401)
    const t = await workingTask(['shop'])
    expect((await rpc(t.url, 'tools/list')).status).toBe(200)
    w.tasks.stop(t.id)
    await until(() => !['starting', 'running', 'stopping'].includes(w.sup.view(t.runId)!.status))
    expect((await rpc(t.url, 'tools/list')).status).toBe(401)
  })
})

describe('connectors on every engine', () => {
  it('gives a Claude worker the gateway and nothing else, and takes away its shell', async () => {
    addShop()
    const t = await workingTask(['shop'])
    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    const mcpFile = args[args.indexOf('--mcp-config') + 1]!
    expect(JSON.parse(readFileSync(mcpFile, 'utf8'))).toEqual({ mcpServers: { hub: { type: 'http', url: t.url } } })
    expect(statSync(mcpFile).mode & 0o077).toBe(0) // carries the run's pass: owner only
    expect(args).toContain('--strict-mcp-config')
    const tools = args[args.indexOf('--tools') + 1]!.split(',')
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('Agent')
    expect(tools).toContain('Read')
    const system = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1]!, 'utf8')
    expect(system).toContain('you can use these connectors: shop')
    expect(system).toContain('shop--')

    // No key anywhere a worker or the dashboard could read it.
    expect(readFileSync(mcpFile, 'utf8')).not.toContain('shop-secret')
    expect(JSON.stringify(w.db.all('select * from runs'))).not.toContain('shop-secret')
    expect(JSON.stringify(w.db.all('select * from tasks'))).not.toContain('shop-secret')
  })

  it('gives a Codex worker the gateway, with commands that can look but not act', async () => {
    addShop()
    const t = await workingTask(['shop'], 'codex')
    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    expect(args).toContain(`mcp_servers.hub.url=${JSON.stringify(t.url)}`)
    expect(args).toContain('--ignore-user-config')
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only'])
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it("gives a Grok worker the gateway in an agent file of its own, still without Grok's own connectors", async () => {
    addShop()
    const t = await workingTask(['shop'], 'grok')
    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    const agentFile = args[args.indexOf('--agent') + 1]!
    expect(readFileSync(agentFile, 'utf8')).toContain(`mcpServers:\n  - hub:\n      type: http\n      url: ${JSON.stringify(t.url)}`)
    expect(statSync(agentFile).mode & 0o077).toBe(0)
    expect(args.filter((a, i) => args[i - 1] === '--deny')).toEqual(['shopsystem__*', 'messages__*'])
    expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('run_terminal_command')
  })

  it('gives a worker without connectors none at all, and its full tools', async () => {
    const t = w.tasks.create({ project: 'shop', brief: 'Fix the header.' })
    await until(() => w.tasks.get(t.id)!.status === 'done')
    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--tools')
  })

  it('refuses a connector that is not set up', () => {
    expect(() => w.tasks.create({ project: 'shop', brief: 'x', connectors: ['bank'] })).toThrow(/No connector called "bank"\. Set up: memory, shopsystem\./)
  })
})

describe('a connector at a web address', () => {
  let remote: Server
  let seen: { auth: string | undefined; session: string | undefined; method: string }[]
  let url: string
  beforeEach(async () => {
    seen = []
    remote = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        const msg = JSON.parse(body)
        seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined, method: msg.method })
        if (req.headers.authorization !== 'Bearer good') return void res.writeHead(401).end()
        if (msg.id === undefined) return void res.writeHead(202).end()
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
          return void res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
        }
        if (msg.method === 'tools/list') {
          // Some servers answer as an event stream, with other events around the answer.
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          return void res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'list-notes', description: 'Notes.' }] } })}\n\n`)
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'No such note.' } }))
      })
    })
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`
  })
  afterEach(() => new Promise((r) => remote.close(r)))

  it('signs in with the header it was given, keeps the session, and reads plain and streamed answers', async () => {
    const c = new HttpClient({ name: 'notes', transport: 'http', url, headers: { Authorization: 'Bearer good' } })
    expect(await c.listTools()).toEqual([{ name: 'list-notes', description: 'Notes.', inputSchema: { type: 'object' } }])
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(seen[2]).toMatchObject({ auth: 'Bearer good', session: 's1' })
    await expect(c.callTool('get-note', {})).rejects.toThrow('No such note.')
  })

  it('says plainly when the sign-in is refused', async () => {
    w.connectors.save({ name: 'notes', url, headers: { Authorization: 'Bearer wrong' } })
    expect((await w.connectors.refresh('notes')).error).toMatch(/refused the sign-in it was given \(HTTP 401\)/)
  })
})

describe('a connector that wants a sign-in through the browser', () => {
  let remote: Server
  let origin: string
  let registered: any
  let tokenCalls: URLSearchParams[]
  let live: string
  beforeEach(async () => {
    tokenCalls = []
    live = 'token-1'
    remote = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        const send = (code: number, o: unknown, headers: Record<string, string> = {}) => void res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(o))
        const path = req.url!.split('?')[0]
        if (path === '/.well-known/oauth-protected-resource/mcp') return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['notes'] })
        if (path === '/.well-known/oauth-authorization-server') return send(200, { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` })
        if (path === '/register') {
          registered = JSON.parse(body)
          return send(201, { client_id: 'client-9' })
        }
        if (path === '/token') {
          const form = new URLSearchParams(body)
          tokenCalls.push(form)
          if (form.get('grant_type') === 'refresh_token') live = 'token-2'
          return send(200, { access_token: live, refresh_token: 'renew-1', expires_in: 3600 })
        }
        if (path === '/mcp') {
          if (req.headers.authorization !== `Bearer ${live}`) return send(401, {}, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` })
          const msg = JSON.parse(body)
          if (msg.id === undefined) return void res.writeHead(202).end()
          return send(200, { jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: [{ name: 'list-notes' }] } : { protocolVersion: '2025-03-26', capabilities: {} } })
        }
        send(404, {})
      })
    })
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise((r) => remote.close(r)))

  it('signs in as an app of its own, keeps the tokens to itself, and renews them when they run out', async () => {
    w.connectors.save({ name: 'notes', url: `${origin}/mcp` })
    expect(await w.connectors.refresh('notes')).toMatchObject({ needsSignIn: true, signedIn: false })

    // The app asks where to send the owner; the page is the connector's own.
    const start = await fetch(`${base}/api/connectors/notes/signin`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(join(w.home.state, 'secret'), 'utf8').trim()}` } })
    const page = new URL(((await start.json()) as { url: string }).url)
    expect(`${page.origin}${page.pathname}`).toBe(`${origin}/authorize`)
    expect(Object.fromEntries(page.searchParams)).toMatchObject({ response_type: 'code', client_id: 'client-9', code_challenge_method: 'S256', resource: `${origin}/mcp`, scope: 'notes', redirect_uri: `${base}/oauth/callback` })
    expect(registered).toMatchObject({ client_name: 'HeyBotOS', redirect_uris: [`${base}/oauth/callback`], token_endpoint_auth_method: 'none' })

    // A callback nobody started is turned away; the real one finishes the sign-in. Neither needs a session.
    expect(await (await fetch(`${base}/oauth/callback?code=abc&state=made-up`)).text()).toContain('Not signed in')
    const back = await (await fetch(`${base}/oauth/callback?code=abc&state=${page.searchParams.get('state')}`)).text()
    expect(back).toContain('Signed in to notes')
    expect(tokenCalls[0]!.get('grant_type')).toBe('authorization_code')
    expect(tokenCalls[0]!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(w.connectors.list().find((c) => c.name === 'notes')).toMatchObject({ signedIn: true, needsSignIn: false, tools: ['list-notes'], error: null })
    expect(JSON.stringify(w.connectors.list())).not.toContain('token-1')
    expect(await (await fetch(`${base}/oauth/callback?code=abc&state=${page.searchParams.get('state')}`)).text()).toContain('Not signed in') // single use

    // The connector stops taking the old token: HeyBotOS renews it and the call goes through.
    live = 'token-expired-elsewhere'
    expect(await w.connectors.refresh('notes')).toMatchObject({ error: null, tools: ['list-notes'] })
    expect(tokenCalls[1]!.get('grant_type')).toBe('refresh_token')
  })
})

describe('notifications', () => {
  it('tells the owner once about a new request and once about a new question', async () => {
    w.home.config.notifications = true
    const sent: string[] = []
    watchInbox(w.home, w.bus, (title, body) => sent.push(`${title} | ${body}`))
    w.home.config.engines.claude.env = { FAKE_FIXTURE: variant(w.root, 'ask', (lines) => lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { status: 'needs_input', summary: 'Two ways.', question: 'Sticky or static?' } } : l))) }
    const t = w.tasks.create({ project: 'shop', title: 'Header', brief: 'Rework it.' })
    await until(() => w.tasks.get(t.id)!.status === 'needs_input')
    expect(sent).toEqual(['Header | Asks: Sticky or static?'])
    w.registry.setNotes('shop', 'x') // unrelated changes do not repeat it
    const run = w.tasks.get(t.id)!.lastRunId!
    w.approvals.check(run, 'Bash', { command: 'ssh web1 true' })
    w.approvals.check(run, 'Bash', { command: 'ssh web1 uptime' })
    expect(sent).toEqual(['Header | Asks: Sticky or static?', 'Header | Waiting for your yes or no: Connect to the server web1'])
  })
})
