import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunView, StoredEvent } from '@heybotos/protocol'
import { BASIC, FIXTURES, killTree, makeWorld, pidAlive, until, variant, type World } from './helpers.ts'
import { PASS_LINUX, PASS_WINDOWS } from '../src/engines/env.ts'

let w: World
beforeEach(() => {
  w = makeWorld()
})
afterEach(() => w.cleanup())

const status = (id: string) => w.sup.view(id)!.status
const pidOf = (id: string) => w.db.get<{ pid: number }>('select pid from runs where id = ?', id)!.pid
const kinds = (id: string) => w.sup.events(id).map((e) => e.kind)

describe('a normal run', () => {
  it('sends text as it is written and the finished text in the order they came, however fast the CLI writes', async () => {
    // The whole recording arrives at once here, which is when the two used to get out of step.
    const seen: string[] = []
    let typing = ''
    w.bus.on('delta', (d) => {
      if (d.channel === 'text' && d.parent === null) typing += d.text
    })
    w.bus.on('event', (e) => {
      if (e.kind !== 'text' || e.parent !== null) return
      // What a page shows while the text is written must be exactly the text that then arrives whole.
      seen.push(typing === String(e.data.text) ? 'in step' : `out of step: typed "${typing.slice(0, 40)}" for "${String(e.data.text).slice(0, 40)}"`)
      typing = ''
    })
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'Fix it', extra: { env: { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl'), FAKE_DELAY_MS: '0' } } })
    await until(() => status(run.id) === 'done', 8000, 'run to finish')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.filter((x) => x !== 'in step')).toEqual([])
    expect(typing).toBe('')
  })

  it('turns the CLI stream into events and a finished run', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'Read the note', extra: w.fake() })
    await until(() => status(run.id) === 'done', 8000, 'run to finish')

    const v = w.sup.view(run.id)!
    expect(v.resultText).toContain('spike-ok')
    expect(v.costUsd).toBeGreaterThan(0)
    expect(v.tokensOut).toBeGreaterThan(0)
    expect(v.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.activity).toBeNull()
    expect(v.endedAt).not.toBeNull()

    const events = w.sup.events(run.id)
    const tools = events.filter((e) => e.kind === 'tool_start').map((e) => e.data.label)
    expect(tools).toEqual(['Reading note.txt', 'Print spike-ok marker'])
    expect(events.filter((e) => e.kind === 'tool_result')).toHaveLength(2)
    expect(events.find((e) => e.kind === 'limit')?.data.status).toBe('allowed_warning')
    expect(events.at(-2)?.kind).toBe('result')
    expect(events.at(-1)?.kind).toBe('usage')
    // Token deltas are live-only and never stored.
    expect(kinds(run.id)).not.toContain('delta')
  })

  it('delivers the whole prompt on stdin, however long', async () => {
    w.sup.start()
    const prompt = 'x'.repeat(300_000) + ' END'
    const out = join(w.root, 'stdin.txt')
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt, extra: w.fake('ok', { FAKE_STDIN_OUT: out }) })
    await until(() => status(run.id) === 'done')
    expect(readFileSync(out, 'utf8')).toBe(prompt)
  })

  it('gives the worker a clean environment, so no key variable can switch it to metered billing', async () => {
    process.env.SOME_PROVIDER_KEY_FOR_TEST = 'must-not-leak'
    w.sup.start()
    const out = join(w.root, 'env.json')
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'hi', extra: w.fake('ok', { FAKE_ENV_OUT: out }) })
    await until(() => status(run.id) === 'done')
    delete process.env.SOME_PROVIDER_KEY_FOR_TEST
    const env: Record<string, string> = JSON.parse(readFileSync(out, 'utf8'))
    expect(JSON.stringify(env)).not.toContain('must-not-leak')
    expect(env.HEYBOTOS_RUN_ID).toBe(run.id)
    expect(env.TERM).toBe('dumb')
    expect(env.HOME).toBeTruthy()
    const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'CI', 'NO_COLOR', 'HEYBOTOS_RUN_ID', 'HEYBOTOS_GATE_URL', 'HEYBOTOS_GATE_TOKEN', 'HEYBOTOS_SHIM_DIR', 'ZDOTDIR', 'BASH_ENV', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING', ...PASS_LINUX, ...PASS_WINDOWS, 'ELECTRON_RUN_AS_NODE', 'LOGONSERVER']
    expect(Object.keys(env).filter((k) => !allowed.includes(k) && !k.startsWith('FAKE_'))).toEqual([])
  })
})

describe('sessions', () => {
  it('starts a session by id and resumes it on the next turn with the permission mode repeated', async () => {
    w.sup.start()
    const args = join(w.root, 'args.json')
    const first = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'one', extra: w.fake('ok', { FAKE_ARGS_OUT: args }) })
    await until(() => status(first.id) === 'done')
    const a1: string[] = JSON.parse(readFileSync(args, 'utf8'))
    expect(a1).toContain('--session-id')
    expect(a1).not.toContain('--resume')
    expect(a1).toContain('--strict-mcp-config')

    const second = w.sup.continue(first.id, 'two')
    await until(() => status(second.id) === 'done')
    const a2: string[] = JSON.parse(readFileSync(args, 'utf8'))
    expect(a2[a2.indexOf('--resume') + 1]).toBe(w.sup.view(first.id)!.sessionId)
    expect(a2).not.toContain('--session-id')
    expect(a2[a2.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(w.sup.view(second.id)!.turn).toBe(2)
    expect(w.sup.view(second.id)!.sessionId).toBe(w.sup.view(first.id)!.sessionId)
  })

  it('refuses to continue an agent that is still working', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'one', extra: w.fake('hang') })
    await until(() => status(run.id) === 'running')
    expect(() => w.sup.continue(run.id, 'more')).toThrow(/still working/)
  })
})

describe('broken streams', () => {
  it('waits for the rest of a half-written line and never stores it twice', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('partial', { FAKE_PARTIAL_MS: '400' }) })
    await until(() => status(run.id) === 'done')
    const events = w.sup.events(run.id)
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'tool_start')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1)
  })

  it('marks a run interrupted when the CLI exits without a result', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('noresult') })
    await until(() => status(run.id) === 'interrupted')
    expect(w.sup.view(run.id)!.error).toMatch(/ended without a result/)
  })

  it('keeps the last error output when the CLI crashes mid-stream', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('crash') })
    await until(() => status(run.id) === 'interrupted')
    expect(w.sup.view(run.id)!.error).toContain('fake: something broke')
    expect(kinds(run.id).at(-1)).toBe('error')
  })

  it('shows non-JSON output instead of dropping it', async () => {
    w.sup.start()
    const lines = readFileSync(BASIC, 'utf8').split('\n').filter(Boolean)
    const fixture = join(w.root, 'noise.jsonl')
    writeFileSync(fixture, [lines[0], 'WARNING: something odd happened', ...lines.slice(1)].join('\n') + '\n')
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: { env: { FAKE_FIXTURE: fixture, FAKE_MODE: 'ok' } } })
    await until(() => status(run.id) === 'done')
    const errors = w.sup.events(run.id).filter((e) => e.kind === 'error')
    expect(errors.map((e) => e.data.message)).toEqual(['WARNING: something odd happened'])
    expect(w.sup.events(run.id).filter((e) => e.kind === 'result')).toHaveLength(1)
  })

  it('fails clearly when the CLI is not installed', async () => {
    w.home.config.engines.claude.bin = '/nowhere/claude'
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p' })
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/Could not find the claude command-line tool/)
  })

  it('rejects a folder that does not exist', () => {
    expect(() => w.sup.create({ engine: 'claude', cwd: '/nowhere/at/all', prompt: 'p' })).toThrow(/Folder does not exist/)
  })
})

describe('stopping', () => {
  it('stops a hung worker when asked and leaves no process behind', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('hang') })
    await until(() => status(run.id) === 'running')
    const pid = pidOf(run.id)
    expect(w.sup.stop(run.id).status).toBe('stopping')
    await until(() => status(run.id) === 'cancelled')
    expect(pidAlive(pid)).toBe(false)
  })

  it('escalates to a hard kill when the worker ignores polite signals', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('ignore-term') })
    await until(() => status(run.id) === 'running')
    const pid = pidOf(run.id)
    w.sup.stop(run.id)
    await until(() => status(run.id) === 'cancelled', 5000)
    expect(pidAlive(pid)).toBe(false)
  })

  it('cancels a queued run without ever starting it', async () => {
    w.home.config.maxWorkers = 1
    w.sup.start()
    const a = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'a', extra: w.fake('hang') })
    const b = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'b', extra: w.fake() })
    expect(status(b.id)).toBe('queued')
    expect(w.sup.stop(b.id).status).toBe('cancelled')
    w.sup.stop(a.id)
    await until(() => status(a.id) === 'cancelled')
    expect(pidOf(b.id)).toBeNull()
  })

  it('stops a worker that goes silent for too long', async () => {
    w.home.config.watchdog.silentSeconds = 0.3
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('hang') })
    await until(() => status(run.id) === 'failed')
    expect(w.sup.view(run.id)!.error).toMatch(/No output for/)
  })

  it('does not count time the Mac spent asleep against a worker', async () => {
    w.home.config.watchdog.silentSeconds = 60
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('hang') })
    await until(() => status(run.id) === 'running')
    w.sup.tick(Date.now() + 3 * 3600_000) // the clock jumps three hours, as after sleep
    await new Promise((r) => setTimeout(r, 100))
    expect(status(run.id)).toBe('running')
  })

  it('ends a worker that printed its result but will not exit', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('linger') })
    await until(() => w.sup.events(run.id).some((e) => e.kind === 'result'))
    const pid = pidOf(run.id)
    w.sup.tick(Date.now() + 11_000)
    await until(() => status(run.id) === 'done')
    expect(pidAlive(pid)).toBe(false)
  })
})

describe('billing protection', () => {
  it('kills a run at once if the CLI is not on the subscription login', async () => {
    w.sup.start()
    const fixture = variant(w.root, 'key', (lines) => lines.map((l) => (l.subtype === 'init' ? { ...l, apiKeySource: 'environment' } : l)))
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: { env: { FAKE_FIXTURE: fixture, FAKE_MODE: 'hang' } } })
    await until(() => status(run.id) === 'failed')
    expect(w.sup.view(run.id)!.error).toMatch(/not using the subscription login/)
    expect(pidAlive(pidOf(run.id))).toBe(false)
  })

  it('kills a run that reports paid extra usage', async () => {
    w.sup.start()
    const fixture = variant(w.root, 'overage', (lines) =>
      lines.map((l) => (l.type === 'rate_limit_event' ? { ...l, rate_limit_info: { ...l.rate_limit_info, isUsingOverage: true } } : l)),
    )
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: { env: { FAKE_FIXTURE: fixture, FAKE_MODE: 'linger', FAKE_DELAY_MS: '5' } } })
    await until(() => status(run.id) === 'failed')
    expect(w.sup.view(run.id)!.error).toMatch(/paid extra usage/)
  })
})

describe('the queue', () => {
  it('runs no more workers at once than the limit and starts the next when a slot frees', async () => {
    w.home.config.maxWorkers = 2
    w.sup.start()
    const slow = w.fake('ok', { FAKE_DELAY_MS: '10' })
    const runs = [1, 2, 3, 4].map((n) => {
      mkdirSync(join(w.root, `folder${n}`))
      return w.sup.create({ engine: 'claude', cwd: join(w.root, `folder${n}`), prompt: `p${n}`, extra: slow })
    })
    expect(runs.map((r) => status(r.id)).filter((s) => s === 'queued')).toHaveLength(2)
    let peak = 0
    await until(() => {
      peak = Math.max(peak, w.sup.activeCount())
      return runs.every((r) => status(r.id) === 'done')
    }, 15_000)
    expect(peak).toBe(2)
  })
})

describe('one worker per folder', () => {
  it('holds a second worker back while another works in the same place, even with slots free', async () => {
    w.home.config.maxWorkers = 3
    w.sup.start()
    const a = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'a', extra: w.fake('ok', { FAKE_DELAY_MS: '15' }) })
    const b = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'b', extra: w.fake() })
    mkdirSync(join(w.root, 'elsewhere'))
    const c = w.sup.create({ engine: 'claude', cwd: join(w.root, 'elsewhere'), prompt: 'c', extra: w.fake() })
    expect(status(b.id)).toBe('queued')
    expect(status(c.id)).not.toBe('queued')
    await until(() => status(a.id) === 'done')
    expect(w.sup.view(b.id)!.startedAt ?? Infinity).toBeGreaterThanOrEqual(w.sup.view(a.id)!.endedAt!)
    await until(() => status(b.id) === 'done')
  })

  it('treats runs that share a lock key as the same place', async () => {
    w.sup.start()
    mkdirSync(join(w.root, 'wt'))
    const a = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'a', lockKey: 'repo-1', extra: w.fake('hang') })
    const b = w.sup.create({ engine: 'claude', cwd: join(w.root, 'wt'), prompt: 'b', lockKey: 'repo-1', extra: w.fake() })
    await until(() => status(a.id) === 'running')
    expect(status(b.id)).toBe('queued')
    w.sup.stop(a.id)
    await until(() => status(b.id) === 'done')
  })
})

describe('daemon restart', () => {
  it('picks a live worker back up and loses or repeats nothing', async () => {
    w.sup.start()
    const seen: StoredEvent[] = []
    w.bus.on('event', (e) => seen.push(e))
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('ok', { FAKE_DELAY_MS: '40' }) })
    await until(() => w.sup.events(run.id).length >= 2)
    w.sup.shutdown() // the daemon goes away mid-run; the worker keeps writing to its file
    const pid = pidOf(run.id)
    expect(pidAlive(pid)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))

    const next = w.restart()
    next.start()
    expect(next.activeCount()).toBe(1)
    await until(() => next.view(run.id)!.status === 'done', 10_000)

    const stored = next.events(run.id)
    expect(stored.filter((e) => e.kind === 'tool_start')).toHaveLength(2)
    expect(stored.filter((e) => e.kind === 'tool_result')).toHaveLength(2)
    expect(stored.filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length)
    expect(seen.map((e) => e.id)).toEqual(stored.map((e) => e.id))
  })

  it('finishes the books for a worker that ended while the daemon was down', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('ok', { FAKE_DELAY_MS: '15' }) })
    await until(() => status(run.id) === 'running')
    w.sup.shutdown()
    const pid = pidOf(run.id)
    await until(() => !pidAlive(pid), 8000, 'worker to end on its own')
    expect(status(run.id)).toBe('running') // nobody was watching

    const next = w.restart()
    next.start()
    expect(next.view(run.id)!.status).toBe('done')
    expect(next.view(run.id)!.resultText).toContain('spike-ok')
    expect(next.activeCount()).toBe(0)
  })

  it('marks a worker interrupted if it died without a result while the daemon was down', async () => {
    w.sup.start()
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake('hang') })
    await until(() => status(run.id) === 'running')
    w.sup.shutdown()
    killTree(pidOf(run.id))
    await until(() => !pidAlive(pidOf(run.id)))
    const next = w.restart()
    next.start()
    expect(next.view(run.id)!.status).toBe('interrupted')
  })

  it('tells listeners when a run finishes', async () => {
    w.sup.start()
    const finished: RunView[] = []
    w.bus.on('finished', (r) => finished.push(r))
    const run = w.sup.create({ engine: 'claude', cwd: w.root, prompt: 'p', extra: w.fake() })
    await until(() => finished.length === 1)
    expect(finished[0]!.id).toBe(run.id)
    expect(finished[0]!.status).toBe('done')
    expect(existsSync(join(w.home.runs, run.id, 'stdout.jsonl'))).toBe(true)
  })
})
