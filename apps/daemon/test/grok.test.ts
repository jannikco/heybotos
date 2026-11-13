import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGrokParser } from '../src/engines/grok.ts'
import { FIXTURES, git, makeWorld, until, type World } from './helpers.ts'

const lines = (name: string) => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)

describe('grok stream parser', () => {
  it('maps a recorded run to the shared vocabulary and reads the report from the end line', () => {
    const parse = createGrokParser()
    const outs = lines('grok-basic.jsonl').map(parse)
    const events = outs.flatMap((o) => o.events)
    expect(events.filter((e) => e.kind === 'tool_start').map((e) => [e.data.name, e.data.label])).toEqual([
      ['Read', 'Reading note.txt'],
      ['Bash', 'Print spike-ok to confirm shell'],
      ['Write', 'Writing made.txt'],
    ])
    expect(events.filter((e) => e.kind === 'tool_result').map((e) => e.data.isError)).toEqual([false, false, false])
    expect(events[0]).toMatchObject({ kind: 'phase', data: { phase: 'init' } })
    expect(events.filter((e) => e.kind === 'phase')).toHaveLength(1)
    const final = outs.find((o) => o.final)!
    expect(final.final).toMatchObject({ status: 'done', error: null, costUsd: null, report: { status: 'done', files_changed: ['made.txt'] } })
    expect(final.patch?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    // With a schema Grok streams the report as text; it must not show up as prose or as typing.
    expect(events.filter((e) => e.kind === 'text')).toEqual([])
    expect(outs.flatMap((o) => o.deltas)).toEqual([])
  })

  it('shows prose when there is no schema, and marks a failed command', () => {
    const parse = createGrokParser()
    const say = [parse(JSON.stringify({ type: 'text', data: 'Looking ' })), parse(JSON.stringify({ type: 'text', data: 'at it.' }))]
    expect(say.flatMap((o) => o.deltas).map((d) => d.text)).toEqual(['Looking ', 'at it.'])
    const call = parse(JSON.stringify({ type: 'tool_call', toolCallId: 'c1', toolName: 'run_terminal_command', rawInput: { command: 'pnpm test' } }))
    expect(call.events.map((e) => [e.kind, e.data.text ?? e.data.label])).toEqual([['text', 'Looking at it.'], ['tool_start', 'pnpm test']])
    const done = parse(JSON.stringify({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { type: 'Bash', exit_code: 1, output_for_prompt: 'exit: 1\nFAIL' } }))
    expect(done.events[0]).toMatchObject({ kind: 'tool_result', data: { isError: true, text: 'exit: 1\nFAIL' } })
    const end = parse(JSON.stringify({ type: 'end', stopReason: 'max_turns', sessionId: 's' }))
    expect(end.final).toMatchObject({ status: 'failed', error: 'Grok stopped early (max_turns).' })
  })
})

describe('a grok worker in a task', () => {
  let w: World
  beforeEach(async () => {
    w = makeWorld()
    mkdirSync(join(w.root, 'code', 'shop'))
    git(join(w.root, 'code', 'shop'), 'init', '-q')
    await w.registry.scan()
    w.sup.start()
  })
  afterEach(() => w.cleanup())

  it('gets its prompt as a file, its rules, a session of its own, and none of the connectors set up in Grok', async () => {
    w.home.config.engines.grok.env = { FAKE_FIXTURE: join(FIXTURES, 'grok-basic.jsonl'), FAKE_ARGS_OUT: join(w.root, 'args.json'), FAKE_STDIN_OUT: join(w.root, 'stdin.txt') }
    const t = w.tasks.create({ project: 'shop', title: 'Make the file', brief: 'Create made.txt.', engine: 'grok' })
    await until(() => w.tasks.get(t.id)!.status === 'done')
    const run = w.tasks.runs(t.id)[0]!
    expect(run).toMatchObject({ engine: 'grok', status: 'done', report: { status: 'done' } })

    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    expect(readFileSync(args[args.indexOf('--prompt-file') + 1]!, 'utf8')).toBe('Task: Make the file\n\nCreate made.txt.')
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toBe('')
    expect(args[args.indexOf('--rules') + 1]).toMatch(/^You are Ada, the team's Engineer\./)
    expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    // One deny rule per connector Grok has configured: a worker reaches none of them.
    const denied = args.flatMap((a, i) => (a === '--deny' ? [args[i + 1]] : []))
    expect(denied).toEqual(['shopsystem__*', 'messages__*'])
    expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('ask_user_question')

    w.home.config.engines.grok.env = { ...w.home.config.engines.grok.env, FAKE_FIXTURE: join(FIXTURES, 'grok-resume.jsonl') }
    w.tasks.answer(t.id, 'Which file was it?')
    await until(() => w.tasks.runs(t.id).length === 2 && w.tasks.get(t.id)!.status === 'done')
    const again: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    expect(again[again.indexOf('--resume') + 1]).toBe(run.sessionId)
    expect(again).not.toContain('--rules')
    expect(w.tasks.get(t.id)!.summary).toBe('The file I created was made.txt.')
  })

  it('does not start at all when it cannot find out which connectors to switch off', async () => {
    w.home.config.engines.grok.bin = join(w.root, 'grok-broken')
    writeFileSync(join(w.root, 'grok-broken'), '#!/bin/sh\nif [ "$1" = mcp ]; then exit 1; fi\nexit 0\n', { mode: 0o755 })
    const t = w.tasks.create({ project: 'shop', brief: 'Anything.', engine: 'grok' })
    await until(() => w.tasks.get(t.id)!.status === 'failed')
    expect(w.tasks.get(t.id)!.summary).toMatch(/Could not ask Grok which connectors it has, so the worker was not started/)
  })
})
