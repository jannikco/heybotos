// Codex in non-interactive mode with JSONL output, one process per turn.
// Shapes below were recorded from real runs (test/fixtures/codex-basic.jsonl, codex-resume.jsonl).
import { readFileSync } from 'node:fs'
import type { NormEvent, WorkerReport } from '@heybotos/protocol'
import type { EngineAdapter, FinalResult, LineParser, ParseOut, SpawnSpec } from './types.ts'
import { clip, oneLine, redact, scrub } from './redact.ts'

type Json = Record<string, any>

export function buildCodexArgs(spec: SpawnSpec): string[] {
  const flags = [
    '--json',
    '--skip-git-repo-check',
    // The owner's own Codex config would bring in their connectors and plugins. Workers get none.
    // The login is still read from the same place.
    '--ignore-user-config',
  ]
  // Full autonomy, as the owner chose. Repeated on resume: without it a resumed turn is read-only.
  // A worker that reads other people's text through connectors may look around but not act: its
  // commands run in the read-only sandbox, which also has no network.
  if (spec.noShell) flags.push('--sandbox', 'read-only', '-c', 'approval_policy="never"')
  else flags.push('--dangerously-bypass-approvals-and-sandbox')
  // The owner's connectors, through HeyBotOS's gateway. Its address carries this run's pass.
  // Codex is told to make these calls without asking: the gateway is where reads pass and changes wait.
  if (spec.hub) flags.push('-c', `mcp_servers.${spec.hub.name}.url=${JSON.stringify(spec.hub.url)}`, '-c', `mcp_servers.${spec.hub.name}.default_tools_approval_mode="approve"`)
  if (spec.model) flags.push('-m', spec.model)
  if (spec.effort) flags.push('-c', `model_reasoning_effort="${spec.effort}"`)
  if (spec.reportSchemaFile) flags.push('--output-schema', spec.reportSchemaFile)
  // "-" = the prompt comes on stdin. The folder is set by the process's working directory:
  // "resume" has no option for it.
  return spec.turn > 1 && spec.sessionId ? ['exec', 'resume', spec.sessionId, ...flags, '-'] : ['exec', ...flags, '-']
}

/** Codex has no option for extra standing instructions, so a new session gets them ahead of the task. */
export function wrapCodexPrompt(spec: SpawnSpec, prompt: string): string {
  if (spec.turn > 1 || !spec.systemPromptFile) return prompt
  return `${readFileSync(spec.systemPromptFile, 'utf8').trim()}\n\n---\n\nYour task:\n\n${prompt}`
}

/** Codex wraps every command in a login shell; show the command itself. */
export function unwrapCommand(command: string): string {
  const m = command.match(/^(?:\S*\/)?(?:zsh|bash|sh|dash)\s+-l?c\s+(['"])([\s\S]*)\1$/)
  if (!m) return command
  return m[1] === '"' ? m[2]!.replace(/\\(["\\$`])/g, '$1') : m[2]!.replace(/'\\''/g, "'")
}

function asReport(text: string): WorkerReport | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    const r = JSON.parse(t) as Json
    return typeof r.status === 'string' && typeof r.summary === 'string' ? (r as WorkerReport) : null
  } catch {
    return null
  }
}

const LIMIT_WORDS = /usage limit|rate limit|quota|too many requests|credits? (are )?(depleted|exhausted)|try again (at|in)|usage_limit|rate_limit/i

export function createCodexParser(): LineParser {
  const started = new Set<string>()
  let lastText: string | null = null
  let report: WorkerReport | null = null
  let lastError: string | null = null

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
    const startTool = (id: string, name: string, label: string, input: Json) => {
      if (started.has(id)) return
      started.add(id)
      push('tool_start', { id, name, label, input: scrub(input), subagent: false })
      out.patch = { ...out.patch, activity: label }
    }

    switch (o.type) {
      case 'thread.started':
        out.patch = { sessionId: o.thread_id }
        push('phase', { phase: 'init', model: 'the Codex default model', connectors: [] })
        break

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item: Json = o.item ?? {}
        const id = String(item.id ?? '')
        const done = o.type === 'item.completed'
        switch (item.type) {
          case 'agent_message': {
            if (!done || !item.text) break
            // With a report schema the last message is the report as JSON; that is not prose to show.
            const r = asReport(item.text)
            if (r) report = r
            else {
              lastText = redact(item.text)
              push('text', { text: lastText })
            }
            break
          }
          case 'reasoning':
            if (done && item.text) push('thinking', { text: redact(clip(String(item.text), 8000)) })
            break
          case 'command_execution': {
            const command = unwrapCommand(String(item.command ?? ''))
            startTool(id, 'Bash', oneLine(command, 90), { command })
            if (done) push('tool_result', { id, name: 'Bash', isError: item.exit_code !== 0 && item.exit_code !== null, text: redact(clip(String(item.aggregated_output ?? ''), 8000)) })
            break
          }
          case 'file_change': {
            const changes: Json[] = Array.isArray(item.changes) ? item.changes : []
            const names = changes.map((c) => String(c.path ?? '').split('/').pop()).filter(Boolean)
            startTool(id, 'Edit', names.length ? `Editing ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}` : 'Editing files', { files: changes.map((c) => `${c.kind ?? 'change'} ${c.path}`) })
            if (done) push('tool_result', { id, name: 'Edit', isError: item.status === 'failed', text: changes.map((c) => `${c.kind ?? 'changed'} ${c.path}`).join('\n') })
            break
          }
          case 'mcp_tool_call': {
            startTool(id, `mcp__${item.server}__${item.tool}`, `${item.server}: ${String(item.tool ?? '').replaceAll('_', ' ')}`, (item.arguments ?? {}) as Json)
            if (done) push('tool_result', { id, name: `mcp__${item.server}__${item.tool}`, isError: item.status === 'failed' || Boolean(item.error), text: redact(clip(JSON.stringify(item.result ?? item.error ?? ''), 8000)) })
            break
          }
          case 'web_search':
            startTool(id, 'WebSearch', `Searching the web for "${oneLine(item.query, 50)}"`, { query: item.query })
            if (done) push('tool_result', { id, name: 'WebSearch', isError: false, text: '' })
            break
          case 'collab_tool_call':
            startTool(id, 'Agent', `Handing off: ${oneLine(item.prompt ?? item.tool ?? 'a sub-agent', 70)}`, { tool: item.tool })
            if (done) push('tool_result', { id, name: 'Agent', isError: item.status === 'failed', text: '' })
            break
          case 'error':
            if (done && item.message) {
              lastError = redact(String(item.message))
              push('error', { message: lastError })
            }
            break
          // todo_list and anything new: nothing to show yet.
        }
        break
      }

      case 'error': {
        lastError = redact(String(o.message ?? 'Codex reported an error.'))
        push('error', { message: lastError })
        if (LIMIT_WORDS.test(lastError)) out.limit = { rejected: true, resetsAt: null, utilization: null }
        break
      }

      case 'turn.completed':
      case 'turn.failed': {
        const failed = o.type === 'turn.failed'
        const message = failed ? redact(String(o.error?.message ?? lastError ?? 'Codex could not finish the turn.')) : null
        if (failed && message && LIMIT_WORDS.test(message)) out.limit = { rejected: true, resetsAt: null, utilization: null }
        const u: Json = o.usage ?? {}
        const final: FinalResult = {
          status: failed ? 'failed' : 'done',
          error: message,
          text: report?.summary ?? lastText,
          report,
          costUsd: null,
          tokensIn: typeof u.input_tokens === 'number' ? u.input_tokens : null,
          tokensOut: typeof u.output_tokens === 'number' ? u.output_tokens : null,
          deferred: null,
        }
        out.final = final
        push('result', { status: final.status, subtype: o.type, text: final.text, report, error: message, turns: null, durationMs: null, stopReason: null, deferred: null, denials: 0 })
        push('usage', { costUsd: null, tokensIn: final.tokensIn, tokensOut: final.tokensOut })
        break
      }
    }
    return out
  }
}

export const codexAdapter: EngineAdapter = {
  engine: 'codex',
  buildArgs: buildCodexArgs,
  createParser: createCodexParser,
  wrapPrompt: wrapCodexPrompt,
}
