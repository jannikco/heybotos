import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, createClaudeParser, describeTool } from '../src/engines/claude.ts'
import { redact, scrub } from '../src/engines/redact.ts'
import { BASIC } from './helpers.ts'

const lines = readFileSync(BASIC, 'utf8').split('\n').filter(Boolean)

describe('claude stream parser', () => {
  it('maps a recorded run to the shared vocabulary in order', () => {
    const parse = createClaudeParser()
    const outs = lines.map(parse)
    const kinds = outs.flatMap((o) => o.events.map((e) => e.kind))
    expect(kinds).toEqual(['phase', 'tool_start', 'tool_start', 'limit', 'tool_result', 'tool_result', 'text', 'result', 'usage'])
    expect(outs.flatMap((o) => o.deltas).map((d) => d.text).join('')).toContain('spike-ok')
    expect(outs.find((o) => o.final)?.final).toMatchObject({ status: 'done', error: null, deferred: null })
    expect(outs.some((o) => o.fatal)).toBe(false)
    expect(outs[0]!.patch?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reads the structured report and hides the tool call that carries it', () => {
    const parse = createClaudeParser()
    const call = parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: { status: 'done' } }] } }))
    expect(call.events).toHaveLength(0)
    const back = parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }))
    expect(back.events).toHaveLength(0)
    const end = parse(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine', structured_output: { status: 'needs_input', summary: 's', question: 'Which colour?' } }))
    expect(end.final?.report).toMatchObject({ status: 'needs_input', question: 'Which colour?' })
  })

  it('treats an error result as failed even when the subtype says success', () => {
    const end = createClaudeParser()(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit" }))
    expect(end.final).toMatchObject({ status: 'failed', error: "You've hit your session limit" })
  })

  it('turns a deferred tool call into a waiting run', () => {
    const end = createClaudeParser()(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_deferred', deferred_tool_use: { id: 'tu_9', name: 'Bash', input: { command: 'ssh web1 true' } } }),
    )
    expect(end.final).toMatchObject({ status: 'waiting', deferred: { id: 'tu_9', name: 'Bash' } })
  })

  it('reports a rejected usage limit', () => {
    const o = createClaudeParser()(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794463200, utilization: 1 } }))
    expect(o.limit).toMatchObject({ rejected: true, resetsAt: 1794463200, utilization: 1, status: 'rejected' })
    expect(o.fatal).toBeUndefined()
  })

  it('nests sub-agent output under the call that started it', () => {
    const parse = createClaudeParser()
    const spawn = parse(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Look for the bug' } }] } }))
    expect(spawn.events[0]).toMatchObject({ kind: 'tool_start', parent: null, data: { subagent: true, label: 'Handing off: Look for the bug' } })
    const inner = parse(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'agent1', message: { content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'TODO' } }] } }))
    expect(inner.events[0]).toMatchObject({ kind: 'tool_start', parent: 'agent1' })
    // What a sub-agent is doing must not replace the worker's own headline.
    expect(inner.patch?.activity).toBeUndefined()
  })
})

describe('tool labels', () => {
  it('describes common tools in plain words', () => {
    expect(describeTool('Edit', { file_path: '/a/b/app.css' })).toBe('Editing app.css')
    expect(describeTool('Bash', { command: 'pnpm   test\n--run' })).toBe('pnpm test --run')
    expect(describeTool('mcp__printshop__search_orders', {})).toBe('printshop: search orders')
    expect(describeTool('WebFetch', { url: 'https://example.com/x' })).toBe('Reading example.com')
  })
})

describe('command line', () => {
  it('never loads connectors the task was not given', () => {
    expect(buildClaudeArgs({ runId: 'r', cwd: '/', sessionId: 's', turn: 1, model: '', effort: '' })).toContain('--strict-mcp-config')
  })
})

describe('redaction', () => {
  it('masks secrets before anything is stored', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe('Authorization: Bearer [hidden]')
    expect(redact('DB_PASSWORD=hunter2hunter2')).toBe('DB_PASSWORD=[hidden]')
    expect(redact('token ghp_abcdefghijklmnopqrstuvwx1234')).toContain('[token hidden]')
    expect(redact('nothing secret here')).toBe('nothing secret here')
    expect(scrub({ command: 'x', nested: { secret_token: 'secret_token=abcdefghijk' } })).toEqual({ command: 'x', nested: { secret_token: 'secret_token=[hidden]' } })
  })
})
