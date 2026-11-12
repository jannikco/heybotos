import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCodexArgs, createCodexParser, unwrapCommand } from '../src/engines/codex.ts'
import { FAKE, FIXTURES, makeWorld, until, type World } from './helpers.ts'

const lines = (name: string) => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)

describe('codex stream parser', () => {
  it('maps a recorded run to the shared vocabulary and reads the report from the last message', () => {
    const parse = createCodexParser()
    const outs = lines('codex-basic.jsonl').map(parse)
    const kinds = outs.flatMap((o) => o.events.map((e) => e.kind))
    expect(kinds).toEqual(['phase', 'text', 'tool_start', 'tool_result', 'tool_start', 'tool_result', 'tool_start', 'tool_result', 'tool_start', 'tool_result', 'result', 'usage'])
    expect(outs[0]!.patch?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    const tools = outs.flatMap((o) => o.events).filter((e) => e.kind === 'tool_start').map((e) => e.data.label)
    expect(tools).toEqual(['cat note.txt', 'echo spike-ok', "printf 'hi\\n' > made.txt", 'cat made.txt'])
    const final = outs.find((o) => o.final)!.final!
    expect(final).toMatchObject({ status: 'done', error: null, report: { status: 'done', files_changed: ['made.txt'] } })
    expect(final.text).toBe(final.report!.summary)
    expect(final.tokensOut).toBeGreaterThan(0)
    // The report JSON itself is never shown as prose.
    expect(outs.flatMap((o) => o.events).filter((e) => e.kind === 'text').map((e) => String(e.data.text)).join('')).not.toContain('"status"')
  })

  it('reports a failed turn, and recognises a usage limit', () => {
    const parse = createCodexParser()
    parse(JSON.stringify({ type: 'thread.started', thread_id: 't' }))
    const out = parse(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 9:14 PM." } }))
    expect(out.final).toMatchObject({ status: 'failed', error: expect.stringContaining('usage limit') })
    expect(out.limit).toEqual({ rejected: true, resetsAt: null, utilization: null })
    const other = createCodexParser()(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }))
    expect(other.limit).toBeUndefined()
  })

  it('marks a command that exits non-zero as failed, and shows file edits', () => {
    const parse = createCodexParser()
    const cmd = parse(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'pnpm test'", aggregated_output: 'FAIL', exit_code: 1, status: 'failed' } }))
    expect(cmd.events.map((e) => e.kind)).toEqual(['tool_start', 'tool_result'])
    expect(cmd.events[1]!.data).toMatchObject({ isError: true, text: 'FAIL' })
    const edit = parse(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/w/a.css', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }], status: 'completed' } }))
    expect(edit.events[0]!.data.label).toBe('Editing a.css, b.ts')
  })

  it('shows the command, not the shell it was wrapped in', () => {
    expect(unwrapCommand("/bin/zsh -lc 'cat note.txt'")).toBe('cat note.txt')
    expect(unwrapCommand('/bin/zsh -lc "printf \'hi\\\\n\' > made.txt"')).toBe("printf 'hi\\n' > made.txt")
    expect(unwrapCommand('bash -c "echo \\"a b\\""')).toBe('echo "a b"')
    expect(unwrapCommand('pnpm test')).toBe('pnpm test')
  })
})

describe('codex command line', () => {
  const spec = { runId: 'r', cwd: '/w', sessionId: null, turn: 1, model: '', effort: '', reportSchemaFile: '/tmp/s.json' }
  it('starts without the owner\'s Codex config and with the prompt on stdin', () => {
    expect(buildCodexArgs(spec)).toEqual(['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox', '--output-schema', '/tmp/s.json', '-'])
  })
  it('resumes by thread id and repeats the autonomy flag', () => {
    const args = buildCodexArgs({ ...spec, sessionId: 'abc', turn: 2 })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'abc'])
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('-C')
    expect(args.at(-1)).toBe('-')
  })
})

describe('a codex worker in a task', () => {
  let w: World
  beforeEach(async () => {
    w = makeWorld()
    mkdirSync(join(w.root, 'code', 'shop'))
    execFileSync('/usr/bin/git', ['-C', join(w.root, 'code', 'shop'), 'init', '-q'])
    await w.registry.scan()
    w.sup.start()
  })
  afterEach(() => w.cleanup())

  it('gets its rules ahead of the task, works in the project folder, and resumes the same thread', async () => {
    const bin = join(w.root, 'codex.sh')
    writeFileSync(bin, `#!/bin/sh\npwd > ${join(w.root, 'cwd.txt')}\nexec ${FAKE} "$@"\n`, { mode: 0o755 })
    w.home.config.engines.codex.bin = bin
    w.home.config.engines.codex.env = { FAKE_FIXTURE: join(FIXTURES, 'codex-basic.jsonl'), FAKE_STDIN_OUT: join(w.root, 'stdin.txt'), FAKE_ARGS_OUT: join(w.root, 'args.json'), FAKE_ENV_OUT: join(w.root, 'env.json') }
    const t = w.tasks.create({ project: 'shop', title: 'Make the file', brief: 'Create made.txt.', engine: 'codex' })
    await until(() => w.tasks.get(t.id)!.status === 'done')

    const run = w.tasks.runs(t.id)[0]!
    expect(run).toMatchObject({ engine: 'codex', status: 'done', report: { status: 'done' } })
    expect(run.sessionId).toBe('01a1cc2f-cefb-76a0-8760-0c23fc8cfa6d') // the thread id Codex reported
    expect(readFileSync(join(w.root, 'cwd.txt'), 'utf8').trim()).toMatch(/code\/shop$/)
    const stdin = readFileSync(join(w.root, 'stdin.txt'), 'utf8')
    expect(stdin).toMatch(/^You are Ada, the team's Engineer\./)
    expect(stdin).toContain('You are a worker agent started by HeyBotOS')
    expect(stdin).toContain('Your task:\n\nTask: Make the file\n\nCreate made.txt.')
    const env = JSON.parse(readFileSync(join(w.root, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.PATH!.split(':')[0]).toBe(join(w.home.state, 'shims'))
    expect(env.ZDOTDIR).toBe(join(w.home.state, 'zdot'))

    w.home.config.engines.codex.env = { ...w.home.config.engines.codex.env, FAKE_FIXTURE: join(FIXTURES, 'codex-resume.jsonl') }
    w.tasks.answer(t.id, 'Which file was it?')
    await until(() => w.tasks.runs(t.id).length === 2 && w.tasks.get(t.id)!.status === 'done')
    const args: string[] = JSON.parse(readFileSync(join(w.root, 'args.json'), 'utf8'))
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '01a1cc2f-cefb-76a0-8760-0c23fc8cfa6d'])
    expect(readFileSync(join(w.root, 'stdin.txt'), 'utf8')).toBe('Which file was it?') // rules are not repeated
    expect(w.tasks.get(t.id)!.summary).toBe('The file I created was made.txt.')
  })

  it('keeps the gate wrappers in front even in a login shell, which is how Codex runs commands', () => {
    mkdirSync(join(w.root, 'bin'))
    writeFileSync(join(w.root, 'bin', 'ssh'), '#!/bin/sh\necho real\n', { mode: 0o755 })
    const shims = join(w.home.state, 'shims')
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v ssh'], {
      encoding: 'utf8',
      env: { PATH: `${shims}:${join(w.root, 'bin')}:/usr/bin:/bin`, HOME: process.env.HOME!, ZDOTDIR: join(w.home.state, 'zdot'), HEYBOTOS_SHIM_DIR: shims },
    }).trim()
    expect(found).toBe(join(shims, 'ssh'))
  })
})
