import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { Auth } from '../src/http/auth.ts'
import { createApp } from '../src/http/app.ts'
import { BASIC, makeWorld, until, type World } from './helpers.ts'

let w: World
let app: Hono
let auth: Auth
const HOST = '127.0.0.1:4747'

beforeEach(() => {
  w = makeWorld()
  auth = new Auth(w.home, w.db, 4747)
  app = createApp({ home: w.home, bus: w.bus, supervisor: w.sup, registry: w.registry, tasks: w.tasks, approvals: w.approvals, manager: w.manager, router: w.router, routines: w.routines, connectors: w.connectors, gateway: w.gateway, staff: w.staff, settings: w.settings, threads: w.threads, auth, version: 'test' })
  w.sup.start()
})
afterEach(() => w.cleanup())

const bearer = () => ({ host: HOST, authorization: `Bearer ${w.home.secret}` })
const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

/** Read SSE frames from a response until `enough` says stop, then hang up. */
async function frames(res: Response, enough: (f: Array<{ event: string; id?: string; data: string }>) => boolean) {
  const out: Array<{ event: string; id?: string; data: string }> = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 8000
  while (!enough(out) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const f: { event: string; id?: string; data: string } = { event: 'message', data: '' }
      for (const line of buf.slice(0, i).split('\n')) {
        if (line.startsWith('event:')) f.event = line.slice(6).trim()
        else if (line.startsWith('id:')) f.id = line.slice(3).trim()
        else if (line.startsWith('data:')) f.data += line.slice(5).trim()
      }
      out.push(f)
      buf = buf.slice(i + 2)
    }
  }
  await reader.cancel()
  return out
}

describe('who gets in', () => {
  it('refuses a request aimed at another host name', async () => {
    const res = await app.request('/api/me', { headers: { host: 'evil.example:4747', authorization: `Bearer ${w.home.secret}` } })
    expect(res.status).toBe(421)
  })

  it('refuses the API without a session or the local secret', async () => {
    expect((await app.request('/api/runs', { headers: { host: HOST } })).status).toBe(401)
    expect((await app.request('/api/runs', { headers: { host: HOST, authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await app.request('/api/runs', { headers: bearer() })).status).toBe(200)
  })

  it('refuses a state-changing request from another site even with a valid cookie', async () => {
    const login = await app.request(`/auth?t=${new URL(auth.loginUrl()).searchParams.get('t')}`, { headers: { host: HOST } })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const res = await app.request('/api/runs', { ...json({ engine: 'claude', cwd: w.root, prompt: 'x' }), headers: { host: HOST, cookie, origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(w.sup.list()).toHaveLength(0)
  })

  it('signs the browser in with a link that works exactly once', async () => {
    const t = new URL(auth.loginUrl()).searchParams.get('t')
    const first = await app.request(`/auth?t=${t}`, { headers: { host: HOST } })
    expect(first.status).toBe(302)
    const cookie = first.headers.get('set-cookie')!
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect((await app.request('/api/me', { headers: { host: HOST, cookie: cookie.split(';')[0]! } })).status).toBe(200)
    expect((await app.request(`/auth?t=${t}`, { headers: { host: HOST } })).status).toBe(403)
  })
})

describe('runs over HTTP', () => {
  it('starts a run, lists it, and returns its events', async () => {
    w.home.config.engines.claude.env = { FAKE_FIXTURE: BASIC, FAKE_MODE: 'ok' }
    // A caller trying to smuggle in per-run internals is ignored: this would hang the fake if honoured.
    const body = { engine: 'claude', cwd: w.root, prompt: 'Read the note', title: 'Note', extra: { env: { FAKE_MODE: 'hang' } } }
    const res = await app.request('/api/runs', { ...json(body), headers: bearer() })
    expect(res.status).toBe(201)
    const { run } = (await res.json()) as { run: { id: string; title: string } }
    expect(run.title).toBe('Note')
    await until(() => w.sup.view(run.id)!.status === 'done')
    const list = (await (await app.request('/api/runs', { headers: bearer() })).json()) as { runs: Array<{ id: string }> }
    expect(list.runs.map((r) => r.id)).toEqual([run.id])
    const ev = (await (await app.request(`/api/runs/${run.id}/events`, { headers: bearer() })).json()) as { events: Array<{ kind: string }> }
    expect(ev.events.at(-2)?.kind).toBe('result')
    expect((await app.request('/api/runs/nope', { headers: bearer() })).status).toBe(404)
  })

  it('explains what is wrong with a bad request', async () => {
    const res = await app.request('/api/runs', { ...json({ engine: 'claude', cwd: '/nowhere', prompt: 'x' }), headers: bearer() })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/Folder does not exist/)
    const res2 = await app.request('/api/runs', { ...json({ engine: 'gemini', cwd: w.root, prompt: 'x' }), headers: bearer() })
    expect(((await res2.json()) as { error: string }).error).toMatch(/Pick an engine/)
  })
})

describe('live stream', () => {
  it('replays stored events after the id the browser last saw, then goes live', async () => {
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake() })
    await until(() => w.sup.view(run.id)!.status === 'done')
    const all = w.sup.events(run.id)

    const full = await frames(await app.request(`/api/runs/${run.id}/stream`, { headers: bearer() }), (f) => f.filter((x) => x.event === 'ev').length >= all.length)
    expect(full[0]!.event).toBe('run')
    expect(full.filter((f) => f.event === 'ev').map((f) => Number(f.id))).toEqual(all.map((e) => e.id))

    const from = all[3]!.id
    const rest = await frames(
      await app.request(`/api/runs/${run.id}/stream`, { headers: { ...bearer(), 'last-event-id': String(from) } }),
      (f) => f.filter((x) => x.event === 'ev').length >= all.length - 4,
    )
    expect(rest.filter((f) => f.event === 'ev').map((f) => Number(f.id))).toEqual(all.slice(4).map((e) => e.id))
  })

  it('streams a run that is still going, with token deltas, without repeating anything', async () => {
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('ok', { FAKE_DELAY_MS: '20' }) })
    const got = await frames(await app.request(`/api/runs/${run.id}/stream`, { headers: bearer() }), (f) =>
      f.some((x) => x.event === 'run' && JSON.parse(x.data).status === 'done'),
    )
    const ids = got.filter((f) => f.event === 'ev').map((f) => Number(f.id))
    expect(ids).toEqual(w.sup.events(run.id).map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(got.some((f) => f.event === 'delta')).toBe(true)
  })

  it('sends the overview stream a snapshot first and then every change', async () => {
    const res = await app.request('/api/stream', { headers: bearer() })
    const pending = frames(res, (f) => f.some((x) => x.event === 'run' && JSON.parse(x.data).status === 'done'))
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake() })
    const got = await pending
    expect(got[0]!.event).toBe('hello')
    expect(got.filter((f) => f.event === 'run').every((f) => JSON.parse(f.data).id === run.id)).toBe(true)
  })
})

describe('storage', () => {
  it('runs in write-ahead mode', () => {
    expect(w.db.journalMode()).toBe('wal')
  })
})
