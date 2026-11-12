import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router } from '../src/router.ts'
import { FAKE, FIXTURES, makeWorld, until, variant, type World } from './helpers.ts'

let w: World
const RICH = join(FIXTURES, 'claude-rich.jsonl')
const status = (id: string) => w.tasks.get(id)!.status
const soon = Math.floor(Date.now() / 1000) + 1800

/** A Claude stream that ends because the usage limit ran out. */
function limited(): string {
  return variant(w.root, 'limited', (lines) =>
    lines.map((l) => {
      if (l.type === 'rate_limit_event') return { ...l, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: soon, isUsingOverage: false } }
      if (l.type === 'result') return { ...l, is_error: true, result: "You've hit your session limit", structured_output: undefined }
      return l
    }),
  )
}

beforeEach(async () => {
  w = makeWorld()
  w.router.cfg.byKind = { build: 'claude', review: 'codex', research: 'claude', write: 'claude', ops: 'claude', other: 'claude' }
  for (const name of ['shop', 'blog', 'docs']) mkdirSync(join(w.root, 'code', name))
  await w.registry.scan()
  w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH }
  w.sup.start()
})
afterEach(() => w.cleanup())

describe('choosing an engine', () => {
  it('follows the rules per kind of work, unless the task names an engine', async () => {
    const build = w.tasks.create({ project: 'shop', brief: 'Build.', kind: 'build' })
    const review = w.tasks.create({ project: 'blog', brief: 'Review.', kind: 'review' })
    const forced = w.tasks.create({ project: 'docs', brief: 'Review with Claude.', kind: 'review', engine: 'claude' })
    expect([build.engine, review.engine, forced.engine]).toEqual(['claude', 'codex', 'claude'])
    await until(() => [build, review, forced].every((t) => status(t.id) === 'done'))
    expect(w.tasks.runs(review.id)[0]!.engine).toBe('codex')
  })

  it('uses the other engine when the preferred one is not signed in, if falling back is allowed', () => {
    w.router.setReady('codex', false)
    expect(w.router.pick('review')).toBe('claude')
    w.router.cfg.fallback = false
    expect(w.router.pick('review')).toBe('codex')
    expect(w.router.whyHeld('codex')).toMatch(/not signed in/)
  })
})

describe('automatic mode: the engines share the work', () => {
  beforeEach(() => {
    w.router.cfg.mode = 'balanced'
    w.router.cfg.pool = ['claude', 'codex', 'grok']
    w.home.config.maxWorkers = 6
    for (const name of ['a', 'b', 'c', 'd', 'e']) mkdirSync(join(w.root, 'code', name))
  })

  it('gives each new task to the engine with the fewest workers out, whatever kind of work it is', async () => {
    await w.registry.scan()
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_MODE: 'hang' }
    w.home.config.engines.codex.env = { FAKE_FIXTURE: join(FIXTURES, 'codex-basic.jsonl'), FAKE_MODE: 'hang' }
    w.home.config.engines.grok.env = { FAKE_FIXTURE: join(FIXTURES, 'grok-basic.jsonl'), FAKE_MODE: 'hang' }
    const engines = ['shop', 'blog', 'docs', 'a', 'b', 'c'].map((p) => w.tasks.create({ project: p, brief: `Work in ${p}.`, kind: 'build' }).engine)
    expect([...engines].sort()).toEqual(['claude', 'claude', 'codex', 'codex', 'grok', 'grok'])
    expect(new Set(engines.slice(0, 3)).size).toBe(3) // the first three went to three different engines
  })

  it('leaves out an engine that is not signed in, on hold, or not in the pool', () => {
    w.router.setReady('grok', false)
    expect(new Set([1, 2, 3, 4].map(() => w.router.pick('build')))).toEqual(new Set(['claude', 'codex']))
    w.router.setReady('grok', true)
    w.router.cfg.pool = ['codex', 'grok']
    expect(new Set([1, 2, 3, 4].map(() => w.router.pick('research')))).toEqual(new Set(['codex', 'grok']))
  })

  it('sends a review to a different engine than the work it checks', async () => {
    await w.registry.scan()
    for (let i = 0; i < 6; i++) {
      const build = w.tasks.create({ project: 'shop', brief: 'Build.', kind: 'build', start: false })
      const review = w.tasks.create({ project: 'shop', brief: 'Review.', kind: 'review', dependsOn: [build.id], start: false })
      expect(review.engine).not.toBe(build.engine)
    }
  })

  it('moves waiting work to another engine when one runs out, and still honours a named engine', async () => {
    await w.registry.scan()
    w.home.config.maxWorkers = 1
    w.home.config.engines.claude.env = { FAKE_FIXTURE: limited(), FAKE_DELAY_MS: '5' }
    const cut = w.tasks.create({ project: 'shop', brief: 'First.', kind: 'build', engine: 'claude' })
    const waiting = w.tasks.create({ project: 'blog', brief: 'Second.', kind: 'build', engine: 'claude' })
    await until(() => w.router.cooling('claude') && w.tasks.get(cut.id)!.waitReason !== null)
    await until(() => status(waiting.id) === 'done')
    expect(['codex', 'grok']).toContain(w.tasks.get(waiting.id)!.engine)
    expect(new Set([1, 2, 3, 4].map(() => w.router.pick('build')))).toEqual(new Set(['codex', 'grok']))
  })
})

describe('when a subscription runs out', () => {
  it('pauses the worker that was cut off, moves waiting work to the other engine, and resumes after the reset', async () => {
    w.home.config.maxWorkers = 1
    w.home.config.engines.claude.env = { FAKE_FIXTURE: limited(), FAKE_DELAY_MS: '5' }
    const cut = w.tasks.create({ project: 'shop', title: 'Cut off', brief: 'A long build.', kind: 'build' })
    const waiting = w.tasks.create({ project: 'blog', title: 'Not started', brief: 'Another build.', kind: 'build' })
    expect(waiting.engine).toBe('claude')

    await until(() => status(cut.id) === 'queued' && w.tasks.get(cut.id)!.waitReason !== null)
    expect(w.tasks.get(cut.id)!.waitReason).toMatch(/Paused: the Claude usage limit ran out mid-task/)
    expect(w.tasks.runs(cut.id)[0]).toMatchObject({ status: 'failed', limited: true })
    expect(w.router.cooling('claude')).toBe(true)

    // The task that had not started was moved and ran on Codex.
    await until(() => status(waiting.id) === 'done')
    expect(w.tasks.get(waiting.id)!.engine).toBe('codex')
    expect(w.tasks.runs(waiting.id)[0]!.engine).toBe('codex')
    // New work avoids Claude while it is on hold.
    expect(w.router.pick('build')).toBe('codex')
    expect(w.router.whyHeld('claude')).toMatch(/usage limit is used up\. It resets at/)

    // The limit resets: the paused worker carries on in its own session.
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH, FAKE_ARGS_OUT: join(w.root, 'args.json'), FAKE_STDIN_OUT: join(w.root, 'stdin.txt') }
    w.router.tick((soon + 5) * 1000)
    await until(() => status(cut.id) === 'done')
    const runs = w.tasks.runs(cut.id)
    expect(runs.map((r) => r.engine)).toEqual(['claude', 'claude'])
    expect(runs[1]!.sessionId).toBe(runs[0]!.sessionId)
    expect(JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))).toContain('--resume')
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toMatch(/cut off by a usage limit/)
    expect(w.router.pick('build')).toBe('claude')
  })

  it('holds work in place when there is no other engine to move it to', async () => {
    w.router.cfg.fallback = false
    w.home.config.maxWorkers = 1
    w.home.config.engines.claude.env = { FAKE_FIXTURE: limited() }
    const cut = w.tasks.create({ project: 'shop', brief: 'First.', kind: 'build' })
    const held = w.tasks.create({ project: 'blog', brief: 'Second.', kind: 'build' })
    await until(() => w.router.cooling('claude') && w.tasks.get(cut.id)!.waitReason !== null)
    await new Promise((r) => setTimeout(r, 200))
    expect(status(held.id)).toBe('queued')
    expect(w.tasks.runs(held.id)[0]!.status).toBe('queued') // never started
    expect(w.tasks.get(held.id)!.waitReason).toMatch(/Claude's usage limit is used up/)
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH }
    w.router.tick((soon + 5) * 1000)
    await until(() => status(held.id) === 'done' && status(cut.id) === 'done')
  })

  it('keeps room for the owner: no new workers on an engine that is nearly at its limit', async () => {
    w.router.cfg.fallback = false
    const nearly = variant(w.root, 'nearly', (lines) => lines.map((l) => (l.type === 'rate_limit_event' ? { ...l, rate_limit_info: { ...l.rate_limit_info, utilization: 0.97, resetsAt: soon } } : l)), RICH)
    w.home.config.engines.claude.env = { FAKE_FIXTURE: nearly }
    const first = w.tasks.create({ project: 'shop', brief: 'First.', kind: 'build' })
    await until(() => status(first.id) === 'done')
    w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH }
    const second = w.tasks.create({ project: 'blog', brief: 'Second.', kind: 'build' })
    await new Promise((r) => setTimeout(r, 200))
    expect(status(second.id)).toBe('queued')
    expect(w.tasks.get(second.id)!.waitReason).toMatch(/Claude is at 97% of its usage limit; new workers are held back to leave room for you/)

    // The manager is the owner's own line and is not held back by the headroom rule.
    w.manager.say('Still there?')
    await until(() => w.manager.state().messages.some((m) => m.role === 'manager'))

    // Once that window has reset the reading no longer counts.
    w.router.tick((soon + 5) * 1000)
    await until(() => status(second.id) === 'done')
  })
})

describe('what the dashboard is told', () => {
  it('reports limit readings, cooldowns and today\'s work per engine, and remembers them across a restart', async () => {
    // The recorded run carries a reset time from the day it was recorded; move it into the future.
    w.home.config.engines.claude.env = { FAKE_FIXTURE: variant(w.root, 'reading', (lines) => lines.map((l) => (l.type === 'rate_limit_event' ? { ...l, rate_limit_info: { ...l.rate_limit_info, resetsAt: soon } } : l))) }
    const t = w.tasks.create({ project: 'shop', brief: 'Anything.', kind: 'build' })
    await until(() => status(t.id) !== 'queued' && status(t.id) !== 'running')
    const [claude, codex, grok] = w.router.usage()
    expect(grok).toMatchObject({ engine: 'grok', ready: true })
    expect(claude).toMatchObject({ engine: 'claude', ready: true, coolingUntil: null, headroom: 0.95, runsToday: 1 })
    expect(claude!.windows).toEqual([expect.objectContaining({ window: 'seven_day', utilization: 0.62, status: 'allowed_warning' })])
    expect(codex).toMatchObject({ engine: 'codex', runsToday: 0, windows: [] })
    expect(w.router.routing().byKind.review).toBe('codex')

    const again = new Router(w.home, w.db, w.bus, w.sup, w.tasks)
    expect(again.usage()[0]!.windows[0]).toMatchObject({ window: 'seven_day', utilization: 0.62 })
    expect(JSON.parse(readFileSync(join(w.home.configDir, 'routing.json'), 'utf8')).fallback).toBe(true)
    writeFileSync(join(w.home.configDir, 'routing.json'), '{ not json')
    expect(() => new Router(w.home, w.db, w.bus, w.sup, w.tasks)).toThrow(/not valid JSON/)
  })
})
