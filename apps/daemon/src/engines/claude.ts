// Claude Code in print mode with stream-json output, one process per turn.
// Shapes below were recorded from a real run (test/fixtures/claude-basic.jsonl), not taken from docs.
import type { NormEvent, WorkerReport } from '@heybotos/protocol'
import type { EngineAdapter, FinalResult, LineParser, ParseOut, SpawnSpec } from './types.ts'
import { clip, oneLine, redact, scrub } from './redact.ts'

type Json = Record<string, any>

const HIDDEN_TOOLS = new Set(['StructuredOutput'])
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

export function buildClaudeArgs(spec: SpawnSpec): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--forward-subagent-text',
    // Full autonomy, as the user chose. The gate hook still sees every call first.
    // Repeated on resume: a resumed session does not remember its permission mode.
    '--permission-mode', 'bypassPermissions',
    // Workers get the connectors named for their task and nothing else. Without this flag every
    // run would load all of the user's live business connectors.
    '--strict-mcp-config',
    // Nobody is at the terminal to answer. A worker that needs a person says so in its report.
    '--disallowed-tools', 'AskUserQuestion',
  ]
  if (spec.turn > 1 && spec.sessionId) args.push('--resume', spec.sessionId)
  else if (spec.sessionId) args.push('--session-id', spec.sessionId)
  if (spec.mcpConfigFile) args.push('--mcp-config', spec.mcpConfigFile)
  if (spec.model) args.push('--model', spec.model)
  if (spec.effort) args.push('--effort', spec.effort)
  if (spec.systemPromptFile) args.push('--append-system-prompt-file', spec.systemPromptFile)
  if (spec.reportSchemaJson) args.push('--json-schema', spec.reportSchemaJson)
  if (spec.settingsFile) args.push('--settings', spec.settingsFile)
  if (spec.tools) args.push('--tools', spec.tools.join(','))
  return args
}

/** A short human line for "what is it doing right now". */
export function describeTool(name: string, input: Json): string {
  const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() || 'a file'
  switch (name) {
    case 'Bash':
      return oneLine(input.description || input.command, 90)
    case 'Read':
      return `Reading ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(input.file_path)}`
    case 'NotebookEdit':
      return `Editing ${base(input.notebook_path)}`
    case 'Write':
      return `Writing ${base(input.file_path)}`
    case 'Grep':
      return `Searching for "${oneLine(input.pattern, 40)}"`
    case 'Glob':
      return `Finding files matching ${oneLine(input.pattern, 40)}`
    case 'WebFetch': {
      try {
        return `Reading ${new URL(String(input.url)).hostname}`
      } catch {
        return 'Reading a web page'
      }
    }
    case 'WebSearch':
      return `Searching the web for "${oneLine(input.query, 50)}"`
    case 'Task':
    case 'Agent':
      return `Handing off: ${oneLine(input.description || input.prompt, 70)}`
    case 'TodoWrite':
      return 'Updating its plan'
  }
  if (name.startsWith('mcp__heybotos__')) {
    const tool = name.slice('mcp__heybotos__'.length)
    const t = oneLine(input.title || input.brief || input.task_id || input.project || input.query || input.name || '', 70)
    const words: Record<string, string> = {
      create_task: `Giving a worker a task${input.project ? ` in ${input.project}` : ''}: ${t}`,
      start_task: `Starting task ${t}`,
      stop_task: `Stopping task ${t}`,
      message_task: `Sending a message to task ${oneLine(input.task_id, 20)}`,
      get_task: `Looking at task ${t}`,
      get_task_log: `Reading what task ${oneLine(input.task_id, 20)} did`,
      list_tasks: 'Checking the task list',
      list_projects: t ? `Looking for projects matching "${t}"` : 'Looking through the projects',
      get_project: `Looking at project ${t}`,
      create_project: `Adding the project ${t}`,
      update_project_notes: `Updating the notes for ${oneLine(input.project, 40)}`,
      save_owner_notes: 'Updating its notes about you',
    }
    return words[tool] ?? `HeyBotOS: ${tool.replaceAll('_', ' ')}`
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__')
    return `${server}: ${tool.replaceAll('_', ' ')}`
  }
  return name
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: Json) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

function asReport(v: unknown): WorkerReport | null {
  if (v === null || typeof v !== 'object') return null
  const r = v as Json
  if (typeof r.status !== 'string' || typeof r.summary !== 'string') return null
  return r as WorkerReport
}

export function createClaudeParser(): LineParser {
  // tool_use id -> tool name, so results can be labelled and sub-agent calls recognised.
  const toolNames = new Map<string, string>()

  return (line: string): ParseOut => {
    const out: ParseOut = { events: [], deltas: [] }
    let o: Json | null = null
    try {
      o = JSON.parse(line)
    } catch {
      o = null
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      // Not an event: the CLI printed something unexpected (a warning, a crash banner). Keep it visible.
      if (line.trim()) out.events.push({ kind: 'error', parent: null, data: { message: redact(clip(line, 2000)), raw: true } })
      return out
    }
    const parent: string | null = o.parent_tool_use_id ?? null
    const push = (kind: NormEvent['kind'], data: Json, p: string | null = parent) => out.events.push({ kind, parent: p, data })

    switch (o.type) {
      case 'system': {
        if (o.subtype === 'init') {
          out.patch = { sessionId: o.session_id, model: o.model }
          push('phase', {
            phase: 'init',
            model: o.model,
            version: o.claude_code_version,
            permissionMode: o.permissionMode,
            connectors: (o.mcp_servers ?? []).map((s: Json) => ({ name: s.name, status: s.status })),
          })
          // "none" is what the subscription login reports. Anything else means a key was picked up
          // from somewhere and the run would be billed per token.
          if (o.apiKeySource && o.apiKeySource !== 'none') {
            out.fatal = `Claude was not using the subscription login (source: ${o.apiKeySource}). Run stopped before any work was billed.`
          }
        } else if (o.subtype === 'api_retry') {
          push('phase', { phase: 'retry', attempt: o.attempt, error: o.error, status: o.error_status })
          if (o.error === 'rate_limit') out.limit = { rejected: false, resetsAt: null, utilization: null }
        } else if (o.subtype === 'compact_boundary') {
          push('phase', { phase: 'compacted' })
        } else if (typeof o.subtype === 'string' && o.subtype.startsWith('task_')) {
          push('subagent', {
            event: o.subtype,
            taskId: o.task_id ?? null,
            toolUseId: o.tool_use_id ?? null,
            description: oneLine(o.description ?? o.summary ?? '', 200),
            status: o.status ?? null,
          })
        }
        // status / hook lines are heartbeats only.
        break
      }

      case 'stream_event': {
        const d = o.event?.delta
        if (o.event?.type === 'content_block_delta' && d) {
          if (d.type === 'text_delta' && d.text) out.deltas.push({ parent, channel: 'text', text: d.text })
          else if (d.type === 'thinking_delta' && d.thinking) out.deltas.push({ parent, channel: 'thinking', text: d.thinking })
        }
        break
      }

      case 'assistant': {
        const msg: Json = o.message ?? {}
        if (o.error) push('error', { message: `Model request failed: ${o.error}`, code: o.error })
        for (const b of (msg.content ?? []) as Json[]) {
          if (b.type === 'text' && b.text) {
            push('text', { text: redact(b.text) })
          } else if (b.type === 'thinking' && b.thinking) {
            push('thinking', { text: redact(clip(b.thinking, 8000)) })
          } else if (b.type === 'tool_use') {
            toolNames.set(b.id, b.name)
            if (HIDDEN_TOOLS.has(b.name)) continue
            const label = describeTool(b.name, b.input ?? {})
            push('tool_start', {
              id: b.id,
              name: b.name,
              label,
              input: scrub(b.input ?? {}),
              subagent: SUBAGENT_TOOLS.has(b.name),
            })
            if (parent === null) out.patch = { ...out.patch, activity: label }
          }
        }
        break
      }

      case 'user': {
        const content = o.message?.content
        if (typeof content === 'string') {
          // Inside a sub-agent the first user message is the brief it was given.
          if (parent) push('subagent', { event: 'prompt', text: redact(clip(content, 4000)) })
          break
        }
        for (const b of (content ?? []) as Json[]) {
          if (b.type === 'tool_result') {
            const name = toolNames.get(b.tool_use_id) ?? null
            if (name && HIDDEN_TOOLS.has(name)) continue
            push('tool_result', {
              id: b.tool_use_id,
              name,
              isError: b.is_error === true,
              text: redact(clip(resultText(b.content), 8000)),
            })
          } else if (b.type === 'text' && parent) {
            push('subagent', { event: 'prompt', text: redact(clip(String(b.text ?? ''), 4000)) })
          }
        }
        break
      }

      case 'rate_limit_event': {
        const i: Json = o.rate_limit_info ?? {}
        const rejected = i.status === 'rejected'
        push('limit', {
          status: i.status,
          window: i.rateLimitType ?? null,
          utilization: i.utilization ?? null,
          resetsAt: i.resetsAt ?? null,
        }, null)
        out.limit = { rejected, resetsAt: i.resetsAt ?? null, utilization: i.utilization ?? null, window: i.rateLimitType ?? null, status: i.status }
        if (i.isUsingOverage === true || i.errorCode === 'credits_required') {
          out.fatal = 'Claude reported paid extra usage. Run stopped: HeyBotOS only works inside the subscription.'
        }
        break
      }

      case 'result': {
        const ok = o.subtype === 'success' && o.is_error !== true
        const deferred = o.deferred_tool_use
          ? { id: String(o.deferred_tool_use.id), name: String(o.deferred_tool_use.name), input: o.deferred_tool_use.input }
          : null
        const errors: string[] = Array.isArray(o.errors) ? o.errors.map(String) : []
        const text = typeof o.result === 'string' ? redact(o.result) : null
        const final: FinalResult = {
          status: deferred ? 'waiting' : ok ? 'done' : 'failed',
          error: ok || deferred ? null : errors.join('; ') || text || `Ended with ${o.subtype ?? 'an error'}`,
          text,
          report: asReport(o.structured_output),
          costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
          tokensIn: o.usage ? (o.usage.input_tokens ?? 0) + (o.usage.cache_creation_input_tokens ?? 0) + (o.usage.cache_read_input_tokens ?? 0) : null,
          tokensOut: o.usage?.output_tokens ?? null,
          deferred,
        }
        out.final = final
        push('result', {
          status: final.status,
          subtype: o.subtype,
          text: final.text,
          report: final.report,
          error: final.error,
          turns: o.num_turns ?? null,
          durationMs: o.duration_ms ?? null,
          stopReason: o.stop_reason ?? null,
          deferred,
          denials: Array.isArray(o.permission_denials) ? o.permission_denials.length : 0,
        }, null)
        push('usage', { costUsd: final.costUsd, tokensIn: final.tokensIn, tokensOut: final.tokensOut }, null)
        break
      }
    }
    return out
  }
}

export const claudeAdapter: EngineAdapter = {
  engine: 'claude',
  ownsSessionId: true,
  buildArgs: buildClaudeArgs,
  createParser: createClaudeParser,
}
