import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, join, normalize } from 'node:path'
import { Hono, type Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import type { ApprovalView, CreateRunInput, CreateTaskInput, LiveDelta, RunView, SettingsPatch, StoredEvent, TaskStage, TaskView, UpdateTaskInput, UpdateState } from '@heybotos/protocol'
import type { Bus } from '../bus.ts'
import type { Home } from '../home.ts'
import type { Registry } from '../registry.ts'
import type { Tasks } from '../tasks.ts'
import type { Approvals } from '../approvals.ts'
import type { Manager } from '../manager.ts'
import type { Router } from '../router.ts'
import type { Routines } from '../routines.ts'
import type { ConnectorRegistry } from '../connect/registry.ts'
import type { Gateway } from '../connect/gateway.ts'
import type { Staff } from '../staff.ts'
import type { Settings } from '../settings.ts'
import type { Threads } from '../threads.ts'
import { handleMcp, managerTools } from '../mcp.ts'
import { pulseKind, type Supervisor } from '../engines/supervisor.ts'
import { engineHealth } from '../health.ts'
import { listModels } from '../models.ts'
import type { Updates } from '../updates.ts'
import type { Auth } from './auth.ts'

export interface AppDeps {
  home: Home
  bus: Bus
  supervisor: Supervisor
  registry: Registry
  tasks: Tasks
  approvals: Approvals
  manager: Manager
  router: Router
  routines: Routines
  connectors: ConnectorRegistry
  gateway: Gateway
  staff: Staff
  settings: Settings
  threads: Threads
  /** How many desktop apps are listening; while one is, it shows the notifications. */
  presence?: { desktop: number }
  auth: Auth
  /** Built dashboard; absent in tests and when only the API is wanted. */
  webRoot?: string
  version: string
  /** "beta" while HeyBotOS is one; absent once it is not. */
  stage?: string
  /** What the Mac app was built from; absent in a checkout. */
  build?: string | null
  /** Finds and fetches newer versions; absent in tests that do not need it. */
  updates?: Updates
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

type Frame = { event: string; data: string; id?: string }

/**
 * Keep an SSE response open and feed it from the bus until the client goes away.
 * Frames are queued so a slow browser never blocks the supervisor.
 */
async function pumpSse(stream: SSEStreamingApi, attach: (send: (f: Frame) => void) => () => void, first: Frame[] = []): Promise<void> {
  const queue: Frame[] = [...first]
  let wake: (() => void) | null = null
  let open = true
  const send = (f: Frame) => {
    if (queue.length > 20_000) queue.splice(0, queue.length - 10_000) // a stuck client loses old frames, not the daemon
    queue.push(f)
    wake?.()
  }
  const detach = attach(send)
  const beat = setInterval(() => send({ event: 'ping', data: '' }), 20_000)
  stream.onAbort(() => {
    open = false
    wake?.()
  })
  try {
    while (open) {
      const f = queue.shift()
      if (f) await stream.writeSSE(f)
      else
        await new Promise<void>((r) => {
          wake = r
        })
      wake = null
    }
  } finally {
    clearInterval(beat)
    detach()
  }
}

/** The terminal command, as it is called from where this copy runs: the Mac app, or a checkout. */
const SELF = process.versions.electron ? 'heybotos' : 'pnpm heybotos'

export function createApp(deps: AppDeps): Hono {
  const { supervisor, registry, tasks, approvals, manager, router, routines, bus, auth, home } = deps
  // Built for each request: the connectors the manager may hand out change while the daemon runs.
  const tools = () => managerTools({ home, registry, tasks, supervisor, routines, connectorNames: deps.connectors.names(), rename: (name) => manager.rename(name), staff: deps.staff, settings: deps.settings })
  const app = new Hono()

  app.onError((err, c) => {
    console.error('[http]', err)
    return c.json({ error: err.message || 'Something went wrong in the daemon.' }, 500)
  })

  // Every request: the Host must be ours.
  app.use('*', async (c, next) => {
    if (!auth.hostOk(c.req.header('host'))) return c.text('Unknown host.', 421)
    await next()
  })

  // Browser sign-in: the daemon prints a single-use link; opening it sets the session cookie.
  app.get('/auth', (c) => {
    const session = auth.redeem(c.req.query('t') ?? '')
    if (!session) return c.text(`This sign-in link has already been used or is not valid. Open the HeyBotOS app, or run "${SELF} open" for a new one.`, 403)
    c.header('Set-Cookie', auth.cookieHeader(session))
    const next = c.req.query('next') ?? ''
    return c.redirect(/^\/[A-Za-z0-9/_-]*$/.test(next) ? next : '/')
  })

  // The manager agent's tool server (MCP over HTTP: one JSON-RPC request in, one JSON answer out).
  // Reached only by the manager's own CLI session, which is the only holder of this token.
  app.post('/mcp', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
    if (!manager.verify(token)) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not authorised.' } }, 401)
    const out = handleMcp(tools(), deps.version, await c.req.json().catch(() => null))
    return out === null ? c.body(null, 202) : c.json(out as object)
  })
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.text('This server answers POST requests only.', 405))

  // The gateway to the owner's connectors (MCP over HTTP). A worker reaches it at an address that
  // is its run's pass; it sees only the connectors its task was given, and every call is gated.
  app.post('/connect/:pass', async (c) => {
    const runId = deps.gateway.runOf(c.req.param('pass'))
    if (!runId) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not authorised.' } }, 401)
    const out = await deps.gateway.handle(runId, await c.req.json().catch(() => null))
    return out === null ? c.body(null, 202) : c.json(out as object)
  })
  app.on(['GET', 'DELETE'], '/connect/:pass', (c) => c.text('This server answers POST requests only.', 405))

  // Where the browser lands after the owner signed in to a connector. It comes from another site,
  // so it carries no session: what proves it is the unguessable, single-use state HeyBotOS handed out.
  app.get('/oauth/callback', async (c) => {
    const page = (title: string, text: string) => c.html(`<!doctype html><meta charset="utf-8"><title>HeyBotOS</title><body style="font: 16px/1.5 system-ui; background: #0a102a; color: #eef0fb; display: grid; place-items: center; height: 100vh; margin: 0"><div style="max-width: 30rem; padding: 2rem"><h1 style="font-size: 1.4rem; margin: 0 0 .5rem">${title}</h1><p style="color: #a5acc9; margin: 0">${text}</p></div>`)
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
    const code = c.req.query('code')
    if (!code) return page('Not signed in', esc(c.req.query('error_description') ?? c.req.query('error') ?? 'The sign-in page did not send a code back.'))
    try {
      const done = await deps.connectors.finishSignIn(c.req.query('state') ?? '', code)
      return page(`Signed in to ${esc(done.name)}`, done.error ? `But it still does not answer: ${esc(done.error)}` : `It offers ${done.tools.length} tools, on every engine. You can close this tab and go back to HeyBotOS.`)
    } catch (e) {
      return page('Not signed in', esc((e as Error).message))
    }
  })

  // The one endpoint workers themselves call (from the gate hook and the ssh/scp wrappers). It takes
  // a per-run token instead of the owner's session, and can only ask: it cannot approve anything.
  app.post('/api/gate/check', async (c) => {
    const [runId = '', token = ''] = (c.req.header('x-heybotos-gate') ?? '').split(':')
    if (!runId || !approvals.verify(runId, token)) return c.json({ decision: 'deny', reason: 'HeyBotOS: this worker could not prove who it is, so the action was not allowed.' }, 403)
    const body = (await c.req.json().catch(() => null)) as { tool?: unknown; input?: unknown } | null
    if (typeof body?.tool !== 'string') return c.json({ decision: 'deny', reason: 'HeyBotOS: the gate could not read the request.' }, 400)
    const input = body.input !== null && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {}
    return c.json(approvals.check(runId, body.tool, input))
  })

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/gate/check') return next()
    if (!['GET', 'HEAD'].includes(c.req.method) && !auth.originOk(c.req.header('origin'))) {
      return c.json({ error: 'Requests from other sites are not accepted.' }, 403)
    }
    if (!auth.authorised({ authorization: c.req.header('authorization'), cookie: c.req.header('cookie') })) {
      return c.json({ error: `Not signed in. Open the HeyBotOS app, or run "${SELF} open".` }, 401)
    }
    await next()
  })

  const bad = (c: Context, message: string) => c.json({ error: message }, 400)

  app.get('/api/me', (c) => c.json({ ok: true, version: deps.version, stage: deps.stage ?? null, build: deps.build ?? null, welcomed: !home.config.welcome || manager.welcomed(), home: home.root, maxWorkers: home.config.maxWorkers, managerName: manager.name() }))

  // ── updates ──
  // The service finds, fetches and checks a newer version; the desktop app installs it.
  const noUpdates: UpdateState = { current: deps.version, latest: null, checkedAt: null, status: 'idle', progress: null, problem: null, how: 'source', hint: null, file: null, auto: false }
  app.get('/api/update', (c) => c.json(deps.updates?.state() ?? noUpdates))
  app.post('/api/update/check', async (c) => c.json((await deps.updates?.check()) ?? noUpdates))
  app.post('/api/update/download', async (c) => c.json((await deps.updates?.download()) ?? noUpdates))

  // For the desktop app: it holds the local secret and trades it for a browser session of its own.
  app.get('/api/login-link', (c) => c.json({ url: auth.loginUrl(c.req.query('next') ?? '') }))

  app.put('/api/identity', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { managerName?: unknown } | null
    try {
      return c.json({ managerName: manager.rename(typeof body?.managerName === 'string' ? body.managerName : '') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.get('/api/health', async (c) => {
    const engines = await engineHealth(home, c.req.query('fresh') === '1')
    for (const e of engines) router.setReady(e.engine, e.loggedIn)
    return c.json({ engines })
  })

  app.get('/api/runs', (c) => c.json({ runs: supervisor.list() }))

  app.post('/api/runs', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<CreateRunInput> | null
    if (!body || typeof body.prompt !== 'string' || typeof body.cwd !== 'string') return bad(c, 'A run needs a folder and a prompt.')
    if (body.engine !== 'claude' && body.engine !== 'codex' && body.engine !== 'grok') return bad(c, 'Pick an engine: claude, codex or grok.')
    // Named fields only: per-run internals (environment, hooks, connectors) are never taken from a request.
    const input: CreateRunInput = {
      engine: body.engine,
      cwd: body.cwd,
      prompt: body.prompt,
      title: typeof body.title === 'string' ? body.title : undefined,
      role: typeof body.role === 'string' ? body.role : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }
    try {
      return c.json({ run: supervisor.create(input) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.get('/api/runs/:id', (c) => {
    const run = supervisor.view(c.req.param('id'))
    return run ? c.json({ run }) : c.json({ error: 'No such run.' }, 404)
  })

  app.get('/api/runs/:id/events', (c) => {
    if (!supervisor.view(c.req.param('id'))) return c.json({ error: 'No such run.' }, 404)
    return c.json({ events: supervisor.events(c.req.param('id'), Number(c.req.query('after') ?? 0)) })
  })

  app.post('/api/runs/:id/stop', (c) => {
    try {
      return c.json({ run: supervisor.stop(c.req.param('id')) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  app.post('/api/runs/:id/continue', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { prompt?: string } | null
    if (!body?.prompt?.trim()) return bad(c, 'Write a message to send.')
    try {
      const taskId = supervisor.view(c.req.param('id'))?.taskId
      if (taskId) {
        // Part of a task: the task decides how to continue, and its state follows.
        const task = tasks.answer(taskId, body.prompt)
        return c.json({ run: supervisor.view(task.lastRunId!) }, 201)
      }
      return c.json({ run: supervisor.continue(c.req.param('id'), body.prompt) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // Everything about one run: stored events replayed from the id the browser last saw, then live
  // events and token deltas. Reconnects send Last-Event-ID, so nothing is shown twice or missed.
  app.get('/api/runs/:id/stream', (c) => {
    const id = c.req.param('id')
    if (!supervisor.view(id)) return c.json({ error: 'No such run.' }, 404)
    const after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0) || 0
    return streamSSE(c, async (stream) => {
      const frame = (e: StoredEvent): Frame => ({ event: 'ev', id: String(e.id), data: JSON.stringify(e) })
      // Subscribe before replaying, then drop what the replay already covered.
      let replayedTo = after
      const early: StoredEvent[] = []
      let live: ((f: Frame) => void) | null = null
      const onEvent = (e: StoredEvent) => {
        if (e.runId !== id) return
        if (live) {
          if (e.id > replayedTo) live(frame(e))
        } else early.push(e)
      }
      const onDelta = (d: LiveDelta) => {
        if (d.runId === id) live?.({ event: 'delta', data: JSON.stringify(d) })
      }
      const onRun = (r: RunView) => {
        if (r.id === id) live?.({ event: 'run', data: JSON.stringify(r) })
      }
      bus.on('event', onEvent)
      const first: Frame[] = [{ event: 'run', data: JSON.stringify(supervisor.view(id)) }]
      for (const e of supervisor.events(id, after, 100_000)) {
        first.push(frame(e))
        replayedTo = e.id
      }
      for (const e of early) if (e.id > replayedTo) first.push(frame(e))
      if (early.length) replayedTo = Math.max(replayedTo, early[early.length - 1]!.id)
      await pumpSse(
        stream,
        (send) => {
          live = send
          bus.on('delta', onDelta)
          bus.on('run', onRun)
          return () => {
            bus.off('event', onEvent)
            bus.off('delta', onDelta)
            bus.off('run', onRun)
          }
        },
        first,
      )
    })
  })

  app.post('/api/welcome', (c) => {
    manager.setWelcomed()
    return c.json({ ok: true })
  })

  // ── projects ──
  app.get('/api/projects', (c) => c.json({ projects: registry.list() }))

  app.post('/api/projects/scan', async (c) => c.json({ count: await registry.scan(), projects: registry.list() }))

  app.post('/api/projects', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown } | null
    if (typeof body?.name !== 'string') return bad(c, 'Give the project a name.')
    try {
      return c.json({ project: registry.createOther(body.name, typeof body.description === 'string' ? body.description : '') }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.get('/api/projects/:slug', (c) => {
    const project = registry.get(c.req.param('slug'))
    if (!project) return c.json({ error: 'No such project.' }, 404)
    return c.json({ project, tasks: tasks.list({ project: project.slug }), worktrees: registry.list().filter((p) => p.parentSlug === project.slug) })
  })

  app.put('/api/projects/:slug', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; starred?: unknown } | null
    if (!registry.get(c.req.param('slug'))) return c.json({ error: 'No such project.' }, 404)
    try {
      const project = registry.update(c.req.param('slug'), { key: typeof body?.key === 'string' ? body.key : undefined, starred: typeof body?.starred === 'boolean' ? body.starred : undefined })
      // Every task of the project is named by its key.
      if (typeof body?.key === 'string') for (const t of tasks.list({ project: project.slug })) bus.emit('task', t)
      return c.json({ project })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.put('/api/projects/:slug/notes', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { notes?: unknown } | null
    if (typeof body?.notes !== 'string') return bad(c, 'Send the notes as text.')
    try {
      return c.json({ project: registry.setNotes(c.req.param('slug'), body.notes.slice(0, 20_000)) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  // ── tasks ──
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  /** The task a request names, by id or by key (BOT-12). */
  const taskOf = (c: Context): TaskView | undefined => tasks.resolve(c.req.param('id') ?? '')

  // Full-text search, and the filters the owner saved. Before /api/tasks/:id so "search" is not read as a task.
  app.get('/api/tasks/search', (c) => c.json({ tasks: tasks.search(c.req.query('q') ?? '') }))
  app.get('/api/filters', (c) => c.json({ filters: tasks.filters() }))
  app.post('/api/filters', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; query?: unknown } | null
    try {
      return c.json({ filter: tasks.saveFilter(typeof body?.name === 'string' ? body.name : '', typeof body?.query === 'string' ? body.query : '') }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })
  app.delete('/api/filters/:id', (c) => {
    tasks.removeFilter(Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  app.get('/api/tasks', (c) => c.json({ tasks: tasks.list({ project: c.req.query('project') || undefined, open: c.req.query('open') === '1' }) }))

  app.post('/api/tasks', async (c) => {
    const b = (await c.req.json().catch(() => null)) as Partial<CreateTaskInput> | null
    if (!b || typeof b.project !== 'string' || typeof b.brief !== 'string') return bad(c, 'A task needs a project and a description of the work.')
    const input: CreateTaskInput = {
      project: b.project,
      brief: b.brief,
      title: typeof b.title === 'string' ? b.title : undefined,
      kind: b.kind,
      engine: b.engine,
      role: typeof b.role === 'string' ? b.role : undefined,
      parentId: typeof b.parentId === 'string' ? b.parentId : undefined,
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.filter((x): x is string => typeof x === 'string') : undefined,
      isolation: b.isolation,
      connectors: Array.isArray(b.connectors) ? b.connectors.filter((x): x is string => typeof x === 'string') : undefined,
      assignee: typeof b.assignee === 'string' && b.assignee ? b.assignee : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
      effort: typeof b.effort === 'string' ? b.effort : undefined,
      start: b.start !== false,
      tier: b.tier === 'epic' ? 'epic' : 'task',
      priority: typeof b.priority === 'string' ? b.priority : undefined,
      labels: strings(b.labels),
      dueAt: typeof b.dueAt === 'number' ? b.dueAt : null,
      files: strings(b.files),
    }
    try {
      return c.json({ task: tasks.create(input, 'user') }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // Everything the task page shows. `task` and `runs` are what earlier callers read.
  app.get('/api/tasks/:id', (c) => {
    const detail = tasks.detail(c.req.param('id'))
    return detail ? c.json(detail) : c.json({ error: 'No such task.' }, 404)
  })

  app.patch('/api/tasks/:id', async (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (b === null || typeof b !== 'object') return bad(c, 'Send what to change.')
    const patch: UpdateTaskInput = {}
    if (typeof b.title === 'string') patch.title = b.title
    if (typeof b.brief === 'string') patch.brief = b.brief.slice(0, 200_000)
    if (typeof b.kind === 'string') patch.kind = b.kind as UpdateTaskInput['kind']
    if (typeof b.priority === 'string') patch.priority = b.priority as UpdateTaskInput['priority']
    if (Array.isArray(b.labels)) patch.labels = strings(b.labels)
    if (typeof b.dueAt === 'number' || b.dueAt === null) patch.dueAt = b.dueAt
    if (typeof b.assignee === 'string' || b.assignee === null) patch.assignee = b.assignee || null
    if (typeof b.engine === 'string') patch.engine = b.engine as UpdateTaskInput['engine']
    if (typeof b.model === 'string') patch.model = b.model
    if (typeof b.effort === 'string') patch.effort = b.effort
    if (typeof b.parentId === 'string' || b.parentId === null) patch.parentId = b.parentId || null
    if (Array.isArray(b.dependsOn)) patch.dependsOn = strings(b.dependsOn)
    if (Array.isArray(b.connectors)) patch.connectors = strings(b.connectors)
    try {
      return c.json({ task: tasks.update(task.id, patch, 'user') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.delete('/api/tasks/:id', (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    try {
      tasks.remove(task.id)
      return c.json({ ok: true })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // A move on the board: to another stage, to another place among its neighbours, or both.
  app.post('/api/tasks/:id/move', async (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    const b = (await c.req.json().catch(() => null)) as { stage?: unknown; before?: unknown; after?: unknown; wontDo?: unknown } | null
    const stage = typeof b?.stage === 'string' && ['backlog', 'next', 'doing', 'needs_you', 'done'].includes(b.stage) ? (b.stage as TaskStage) : undefined
    try {
      return c.json({ task: tasks.move(task.id, { stage, before: typeof b?.before === 'string' ? b.before : undefined, after: typeof b?.after === 'string' ? b.after : undefined, wontDo: b?.wontDo === true }, 'user') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.post('/api/tasks/:id/comments', async (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    const b = (await c.req.json().catch(() => null)) as { text?: unknown; files?: unknown; send?: unknown } | null
    try {
      return c.json({ comment: tasks.comment(task.id, 'user', typeof b?.text === 'string' ? b.text.slice(0, 50_000) : '', { files: strings(b?.files), send: b?.send === true }) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })
  app.put('/api/comments/:id', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    try {
      return c.json({ comment: tasks.editComment(Number(c.req.param('id')), typeof b?.text === 'string' ? b.text.slice(0, 50_000) : '') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })
  app.delete('/api/comments/:id', (c) => {
    try {
      tasks.removeComment(Number(c.req.param('id')))
      return c.json({ ok: true })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.post('/api/tasks/:id/files', async (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    const b = (await c.req.json().catch(() => null)) as { files?: unknown } | null
    try {
      return c.json({ task: tasks.attach(task.id, strings(b?.files) ?? [], 'user') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })
  app.delete('/api/tasks/:id/files/:file', (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    return c.json({ task: tasks.detach(task.id, c.req.param('file'), 'user') })
  })

  app.post('/api/tasks/:id/links', async (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    const b = (await c.req.json().catch(() => null)) as { to?: unknown; type?: unknown } | null
    try {
      tasks.link(task.id, typeof b?.to === 'string' ? b.to : '', b?.type === 'duplicates' ? 'duplicates' : 'relates', 'user')
      return c.json({ ok: true }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })
  app.delete('/api/links/:id', (c) => {
    try {
      tasks.unlink(Number(c.req.param('id')), 'user')
      return c.json({ ok: true })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // ── files ──
  // An upload is the file itself as the request body, with its name in the address. It is hung on
  // a task, a comment or a message afterwards, by its id.
  app.post('/api/files', async (c) => {
    const name = c.req.query('name') ?? ''
    if (!name.trim()) return bad(c, 'Say what the file is called.')
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > tasks.files.maxBytes) return c.json({ error: 'That file is larger than HeyBotOS takes.' }, 413)
    try {
      return c.json({ file: await tasks.files.save(name, c.req.header('content-type') ?? '', c.req.raw.body) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // Handed back so that nothing in a file can run in the dashboard: only plain pictures are shown
  // in place, everything else is a download, and no file may load or run anything.
  app.get('/api/files/:id', (c) => {
    const row = tasks.files.row(c.req.param('id'))
    if (!row || !existsSync(row.path)) return c.json({ error: 'No such file.' }, 404)
    const { type, inline } = tasks.files.serving(row)
    const quoted = encodeURIComponent(row.name)
    return new Response(Readable.toWeb(createReadStream(row.path)) as ReadableStream, {
      headers: {
        'Content-Type': type,
        'Content-Length': String(row.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${quoted}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, max-age=3600',
      },
    })
  })

  app.get('/api/tasks/:id/changes', (c) => {
    const task = taskOf(c)
    if (!task) return c.json({ error: 'No such task.' }, 404)
    try {
      return c.json({ changes: tasks.changes(task.id) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  for (const action of ['start', 'stop', 'undo'] as const) {
    app.post(`/api/tasks/:id/${action}`, (c) => {
      const id = taskOf(c)?.id
      if (!id) return c.json({ error: 'No such task.' }, 404)
      try {
        if (action === 'undo') return c.json({ ...tasks.undo(id), task: tasks.get(id) })
        return c.json({ task: action === 'start' ? tasks.start(id) : tasks.stop(id) })
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
  }

  app.post('/api/tasks/:id/answer', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    const id = taskOf(c)?.id
    if (!id) return c.json({ error: 'No such task.' }, 404)
    try {
      return c.json({ task: tasks.answer(id, typeof body?.text === 'string' ? body.text : '') })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // ── the conversation with the manager ──
  app.get('/api/chat', (c) => c.json(manager.state(c.req.query('thread') || undefined)))

  // The conversations for the sidebar, and "I have seen this one".
  app.get('/api/threads', (c) => c.json({ threads: deps.threads.list(manager.name()) }))
  app.post('/api/threads/:id/read', (c) => {
    deps.threads.markRead(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/chat', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; thread?: unknown; files?: unknown } | null
    try {
      return c.json({ message: manager.say(typeof body?.text === 'string' ? body.text.slice(0, 50_000) : '', typeof body?.thread === 'string' && body.thread ? body.thread : 'chief', strings(body?.files) ?? []) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.post('/api/chat/stop', (c) => {
    manager.interrupt()
    return c.json({ ok: true })
  })

  // The models and effort levels each engine offers on the owner's plans, for the pickers.
  app.get('/api/models', async (c) => c.json({ models: await listModels(home, c.req.query('fresh') === '1') }))

  // ── settings ──
  app.get('/api/settings', (c) => c.json({ settings: deps.settings.read() }))

  app.put('/api/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as SettingsPatch | null
    if (body === null || typeof body !== 'object') return bad(c, 'Send the settings to change.')
    try {
      return c.json({ settings: deps.settings.apply(body) })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // ── the team ──
  app.get('/api/staff', (c) => c.json({ staff: deps.staff.list() }))

  const staffFields = (b: Record<string, unknown>) => ({
    name: typeof b.name === 'string' ? b.name : undefined,
    title: typeof b.title === 'string' ? b.title : undefined,
    focus: Array.isArray(b.focus) ? b.focus.map(String) : undefined,
    engine: typeof b.engine === 'string' ? b.engine : undefined,
    model: typeof b.model === 'string' ? b.model : undefined,
    effort: typeof b.effort === 'string' ? b.effort : undefined,
    persona: typeof b.persona === 'string' ? b.persona : undefined,
    memory: typeof b.memory === 'string' ? b.memory : undefined,
    hue: typeof b.hue === 'number' ? b.hue : undefined,
    active: typeof b.active === 'boolean' ? b.active : undefined,
  })

  app.post('/api/staff', async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    try {
      return c.json({ member: deps.staff.save(staffFields(body)) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.put('/api/staff/:id', async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    try {
      return c.json({ member: deps.staff.save({ id: c.req.param('id'), ...staffFields(body) }) })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // HeyBotOS's own connectors. What goes out is names, where each lives and its tools: never a key.
  app.get('/api/connectors', (c) => c.json({ connectors: deps.connectors.names(), list: deps.connectors.list() }))
  app.post('/api/connectors', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const pairs = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => k.trim() && typeof x === 'string').map(([k, x]) => [k.trim(), x as string])) : undefined)
    try {
      const saved = deps.connectors.save({ name: text(b.name) ?? '', url: text(b.url), command: text(b.command), args: Array.isArray(b.args) ? b.args.map(String) : undefined, headers: pairs(b.headers), env: pairs(b.env) })
      return c.json({ connector: await deps.connectors.refresh(saved.name) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.post('/api/connectors/import', async (c) => {
    const result = deps.connectors.importFromClaude()
    await Promise.all(result.added.map((n) => deps.connectors.refresh(n)))
    return c.json({ ...result, list: deps.connectors.list() })
  })
  app.post('/api/connectors/:name/check', async (c) => {
    try {
      return c.json({ connector: await deps.connectors.refresh(c.req.param('name')) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })
  // Signing in to a connector through the browser: the app opens the page this gives back.
  app.post('/api/connectors/:name/signin', async (c) => {
    try {
      return c.json({ url: await deps.connectors.startSignIn(c.req.param('name'), new URL(c.req.url).origin) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.post('/api/connectors/:name/enabled', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown }
    try {
      return c.json({ connector: deps.connectors.setEnabled(c.req.param('name'), b.enabled === true) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })
  app.delete('/api/connectors/:name', (c) => {
    deps.connectors.remove(c.req.param('name'))
    return c.json({ ok: true })
  })

  // ── routines ──
  app.get('/api/routines', (c) => c.json({ routines: routines.list() }))

  app.post('/api/routines', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { title?: unknown; schedule?: unknown; prompt?: unknown } | null
    try {
      return c.json({ routine: routines.create({ title: String(b?.title ?? ''), schedule: String(b?.schedule ?? ''), prompt: String(b?.prompt ?? '') }) }, 201)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.post('/api/routines/:id/:action', (c) => {
    const { id, action } = c.req.param()
    try {
      if (action === 'run') return c.json({ routine: routines.runNow(id) })
      if (action === 'enable' || action === 'disable') return c.json({ routine: routines.setEnabled(id, action === 'enable') })
      return c.json({ error: 'No such action.' }, 404)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  app.delete('/api/routines/:id', (c) => {
    try {
      routines.remove(c.req.param('id'))
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  // ── usage and routing ──
  app.get('/api/usage', (c) => c.json({ engines: router.usage(), routing: router.routing() }))

  // ── inbox ──
  app.get('/api/inbox', (c) =>
    c.json({
      approvals: approvals.list('pending'),
      decided: approvals.list('all').filter((a) => a.status !== 'pending').slice(0, 30),
      gate: { allowedHosts: approvals.cfg.allowedHosts, alwaysAllowTools: approvals.cfg.alwaysAllowTools, hostGrantMinutes: approvals.cfg.hostGrantMinutes, file: join(home.configDir, 'gate.json') },
    }),
  )

  for (const verb of ['approve', 'deny'] as const) {
    app.post(`/api/approvals/:id/${verb}`, async (c) => {
      const body = (await c.req.json().catch(() => null)) as { note?: unknown; always?: unknown } | null
      try {
        return c.json({ approval: approvals.decideApproval(c.req.param('id'), verb === 'approve', typeof body?.note === 'string' ? body.note.slice(0, 500) : '', body?.always === true) })
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
  }

  // What each run has been doing over time, in a form small enough to draw for a whole list:
  // [seconds since the run started, kind] per notable event.
  app.get('/api/pulse', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 100)
    const pulse: Record<string, Array<[number, string]>> = {}
    for (const id of ids) pulse[id] = supervisor.pulse(id)
    return c.json({ pulse })
  })

  // The overview: one frame whenever any run changes state or activity, plus a tick per notable event.
  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const desktop = c.req.query('client') === 'desktop'
      if (desktop && deps.presence) deps.presence.desktop++
      stream.onAbort(() => {
        if (desktop && deps.presence) deps.presence.desktop--
      })
      await pumpSse(
        stream,
        (send) => {
          const onRun = (r: RunView) => send({ event: 'run', data: JSON.stringify(r) })
          const onEvent = (e: StoredEvent) => {
            const kind = pulseKind(e)
            if (kind) send({ event: 'tick', data: JSON.stringify({ runId: e.runId, ts: e.ts, kind }) })
          }
          const onTask = (t: TaskView) => send({ event: 'task', data: JSON.stringify(t) })
          const onGone = (x: { id: string }) => send({ event: 'task-removed', data: JSON.stringify(x) })
          bus.on('task-removed', onGone)
          const onApproval = (a: ApprovalView) => send({ event: 'approval', data: JSON.stringify(a) })
          bus.on('approval', onApproval)
          const onChat = (x: unknown) => send({ event: 'chat', data: JSON.stringify(x) })
          bus.on('chat', onChat)
          const onIdentity = (x: unknown) => send({ event: 'identity', data: JSON.stringify(x) })
          bus.on('identity', onIdentity)
          const onUpdate = (x: unknown) => send({ event: 'update', data: JSON.stringify(x) })
          bus.on('update', onUpdate)
          bus.on('run', onRun)
          bus.on('event', onEvent)
          bus.on('task', onTask)
          return () => {
            bus.off('run', onRun)
            bus.off('event', onEvent)
            bus.off('task', onTask)
            bus.off('task-removed', onGone)
            bus.off('approval', onApproval)
            bus.off('chat', onChat)
            bus.off('identity', onIdentity)
            bus.off('update', onUpdate)
          }
        },
        [{ event: 'hello', data: JSON.stringify({ runs: supervisor.list(), tasks: tasks.list(), approvals: approvals.list('pending') }) }],
      )
    }),
  )

  app.all('/api/*', (c) => c.json({ error: 'No such endpoint.' }, 404))

  // The dashboard itself. Its files are not secret; the data behind /api is.
  app.get('*', (c) => {
    if (!deps.webRoot) return c.text('HeyBotOS daemon is running. The dashboard has not been built yet: run "pnpm build".', 200)
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(deps.webRoot, rel)
    if (!file.startsWith(deps.webRoot) || !existsSync(file) || rel === '/' || extname(file) === '') file = join(deps.webRoot, 'index.html')
    if (!existsSync(file)) return c.text('Dashboard files are missing: run "pnpm build".', 500)
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    c.header('Content-Type', type)
    c.header('Cache-Control', file.includes(`${join(deps.webRoot, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    return c.body(readFileSync(file))
  })

  return app
}
