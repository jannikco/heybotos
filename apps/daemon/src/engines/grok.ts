// Grok Build in headless mode with streaming-json output, one process per turn.
// Shapes below were recorded from real runs (test/fixtures/grok-basic.jsonl, grok-resume.jsonl).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NormEvent, WorkerReport } from '@heybotos/protocol'
import type { EngineAdapter, FinalResult, LineParser, ParseOut, SpawnSpec } from './types.ts'
import { clip, oneLine, redact, scrub } from './redact.ts'

type Json = Record<string, any>

/**
 * The connectors configured in Grok itself. A worker must not reach them: Grok has no hook for the
 * gate, so each one is switched off for the run with a deny rule. If the list cannot be read the
 * worker is not started at all.
 */
const serverCache = new Map<string, { at: number; names: string[] }>()
export function grokConnectors(bin: string, env: Record<string, string>): string[] {
  const hit = serverCache.get(bin)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.names
  let out: string
  try {
    out = execFileSync(bin, ['mcp', 'list'], { env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    throw new Error(`Could not ask Grok which connectors it has, so the worker was not started (it would have had all of them): ${oneLine((e as Error).message, 200)}`)
  }
  const names = [...out.matchAll(/^\s*([A-Za-z0-9_.-]+):\s+\S/gm)].map((m) => m[1]!)
  serverCache.set(bin, { at: Date.now(), names })
  return names
}

export function buildGrokArgs(spec: SpawnSpec): string[] {
  const args = [
    '--prompt-file', spec.promptFile ?? '',
    '--output-format', 'streaming-json',
    // Full autonomy, as the owner chose; the ssh/scp/rsync wrappers on PATH are this engine's gate.
    '--permission-mode', 'bypassPermissions',
    '--always-approve',
  ]
  if (spec.turn > 1 && spec.sessionId) args.push('--resume', spec.sessionId)
  else if (spec.sessionId) args.push('--session-id', spec.sessionId)
  if (spec.model) args.push('--model', spec.model)
  if (spec.effort) args.push('--reasoning-effort', spec.effort)
  // Standing instructions go in as extra rules; like the others, only a new session needs them.
  if (spec.systemPromptFile && spec.turn === 1) args.push('--rules', readFileSync(spec.systemPromptFile, 'utf8'))
  if (spec.reportSchemaJson) args.push('--json-schema', spec.reportSchemaJson)
  for (const server of spec.bin ? grokConnectors(spec.bin, spec.env ?? {}) : []) {
    if (server !== spec.hub?.name) args.push('--deny', `${server}__*`)
  }
  // The owner's connectors, through HeyBotOS's gateway. Grok takes a run's own MCP server from an agent
  // file; its address carries this run's pass, so the file is the owner's only.
  if (spec.hub && spec.runDir) {
    const file = join(spec.runDir, 'grok-agent.md')
    writeFileSync(file, `---\nname: heybotos-worker\ndescription: A HeyBotOS worker.\nmcpServers:\n  - ${spec.hub.name}:\n      type: http\n      url: ${JSON.stringify(spec.hub.url)}\n---\n`, { mode: 0o600 })
    args.push('--agent', file)
  }
  // Nobody is at the terminal, and a worker does not set up schedules of its own. One that reads
  // other people's text through connectors gets no terminal either.
  args.push('--disallowed-tools', `ask_user_question,scheduler_create,scheduler_delete${spec.noShell ? ',run_terminal_command' : ''}`)
  return args
}

function describe(tool: string, input: Json): { name: string; label: string } {
  const base = (p: unknown) => String(p ?? '').split('/').pop() || 'a file'
  switch (tool) {
    case 'run_terminal_command':
      return { name: 'Bash', label: oneLine(input.description || input.command, 90) }
    case 'read_file':
      return { name: 'Read', label: `Reading ${base(input.target_file ?? input.file_path)}` }
    case 'write':
      return { name: 'Write', label: `Writing ${base(input.file_path)}` }
    case 'search_replace':
      return { name: 'Edit', label: `Editing ${base(input.file_path)}` }
    case 'grep':
    case 'search':
      return { name: 'Grep', label: `Searching for "${oneLine(input.pattern ?? input.query, 40)}"` }
    case 'list_dir':
    case 'glob':
      return { name: 'Glob', label: `Looking through ${base(input.target_directory ?? input.path ?? input.pattern)}` }
    case 'web_search':
      return { name: 'WebSearch', label: `Searching the web for "${oneLine(input.query, 50)}"` }
    case 'web_fetch':
      return { name: 'WebFetch', label: 'Reading a web page' }
  }
  return { name: tool, label: tool.replaceAll('_', ' ') }
}

function outputText(o: Json): string {
  const raw: Json | null = o.rawOutput
  if (raw && typeof raw.output_for_prompt === 'string') return raw.output_for_prompt
  const parts: string[] = []
  for (const c of (o.content ?? []) as Json[]) {
    if (c.type === 'content' && c.content?.type === 'text') parts.push(String(c.content.text ?? ''))
    else if (c.type === 'diff') parts.push(`changed ${c.path}`)
  }
  return parts.join('\n')
}

const LIMIT_WORDS = /usage limit|rate limit|quota|too many requests|limit (reached|exceeded)|try again (at|in)/i

export function createGrokParser(): LineParser {
  const started = new Set<string>()
  const finished = new Set<string>()
  let prose = '' // text since the last tool call; shown as one block when something else happens
  let lastText: string | null = null

  return (line: string): ParseOut => {
    const out: ParseOut = { events: [], deltas: [] }
    let o: Json | null = null
    try {
      o = JSON.parse(line)
    } catch {
      o = null
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      if (line.trim()) out.events.push({ kind: 'error', parent: null, data: { message: redact(clip(line, 2000)), raw: true } })
      return out
    }
    const push = (kind: NormEvent['kind'], data: Json) => out.events.push({ kind, parent: null, data })
    // With a report schema Grok streams the report itself as text; that is not prose to show.
    const flush = () => {
      const t = prose.trim()
      prose = ''
      if (!t || t.startsWith('{')) return
      lastText = redact(t)
      push('text', { text: lastText })
    }

    switch (o.type) {
      case 'available_commands':
        if (started.size === 0 && !started.has('init')) {
          started.add('init')
          push('phase', { phase: 'init', model: 'the Grok default model', connectors: [] })
        }
        break
      case 'thought':
        if (o.data) push('thinking', { text: redact(clip(String(o.data), 8000)) })
        break
      case 'text':
        if (typeof o.data === 'string') {
          prose += o.data
          if (!prose.trimStart().startsWith('{')) out.deltas.push({ parent: null, channel: 'text', text: o.data })
        }
        break
      case 'tool_call': {
        flush()
        const id = String(o.toolCallId)
        if (started.has(id)) break
        started.add(id)
        const d = describe(String(o.toolName ?? o.title ?? 'tool'), (o.rawInput ?? {}) as Json)
        push('tool_start', { id, name: d.name, label: d.label, input: scrub(o.rawInput ?? {}), subagent: false })
        out.patch = { activity: d.label }
        break
      }
      case 'tool_call_update': {
        const id = String(o.toolCallId)
        if ((o.status === 'completed' || o.status === 'failed') && !finished.has(id)) {
          finished.add(id)
          const code = o.rawOutput?.exit_code
          push('tool_result', { id, name: null, isError: o.status === 'failed' || (typeof code === 'number' && code !== 0), text: redact(clip(outputText(o), 8000)) })
        }
        break
      }
      case 'error': {
        flush()
        const message = redact(String(o.message ?? o.data ?? 'Grok reported an error.'))
        push('error', { message })
        if (LIMIT_WORDS.test(message)) out.limit = { rejected: true, resetsAt: null, utilization: null }
        break
      }
      case 'end': {
        flush()
        const report = o.structuredOutput && typeof o.structuredOutput.status === 'string' && typeof o.structuredOutput.summary === 'string' ? (o.structuredOutput as WorkerReport) : null
        const ok = o.stopReason === 'end_turn' || o.stopReason === 'stop' || report !== null
        const error = ok ? null : `Grok stopped early (${o.stopReason ?? 'no reason given'}).`
        if (error && LIMIT_WORDS.test(String(o.stopReason ?? ''))) out.limit = { rejected: true, resetsAt: null, utilization: null }
        const u: Json = o.usage ?? {}
        const final: FinalResult = {
          status: ok ? 'done' : 'failed',
          error,
          text: report?.summary ?? lastText,
          report,
          costUsd: null, // the CLI prints a list-price figure; on a subscription nothing is billed per run
          tokensIn: typeof u.input_tokens === 'number' ? u.input_tokens : null,
          tokensOut: typeof u.output_tokens === 'number' ? u.output_tokens : null,
          deferred: null,
        }
        out.final = final
        if (typeof o.sessionId === 'string') out.patch = { ...out.patch, sessionId: o.sessionId }
        push('result', { status: final.status, subtype: o.stopReason, text: final.text, report, error, turns: o.num_turns ?? null, durationMs: null, stopReason: o.stopReason ?? null, deferred: null, denials: 0 })
        push('usage', { costUsd: null, tokensIn: final.tokensIn, tokensOut: final.tokensOut })
        break
      }
    }
    return out
  }
}

export const grokAdapter: EngineAdapter = {
  engine: 'grok',
  buildArgs: buildGrokArgs,
  createParser: createGrokParser,
  promptFromFile: true,
  ownsSessionId: true,
}
