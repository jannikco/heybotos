import type { Engine, NormEvent, RunStatus, WorkerReport } from '@heybotos/protocol'

/** Everything an adapter needs to build one CLI invocation. */
export interface SpawnSpec {
  runId: string
  cwd: string
  sessionId: string | null
  /** 1 = new session, anything higher resumes sessionId. */
  turn: number
  model: string
  effort: string
  /** The CLI binary and the environment the worker will get, for adapters that must ask the CLI something first. */
  bin?: string
  env?: Record<string, string>
  /** The prompt as a file, for CLIs that take it that way instead of on stdin. */
  promptFile?: string
  /** File with role and house rules, appended to the CLI's own system prompt. */
  systemPromptFile?: string
  /** JSON Schema for the final report: as text (Claude takes it inline) and as a file (Codex wants a path). */
  reportSchemaJson?: string
  reportSchemaFile?: string
  /** MCP config file; workers get exactly these servers and no others. */
  mcpConfigFile?: string
  /** HeyBotOS's gateway to the owner's connectors, when this run was given any: one MCP server at a web address. */
  hub?: { name: string; url: string }
  /** The run's private folder, for adapters that must write a file of their own. */
  runDir?: string
  /** No shell for this run (it reads text other people wrote). */
  noShell?: boolean
  /** Settings file carrying the gate hook. */
  settingsFile?: string
  /** Built-in tools to allow; undefined = the CLI default set. */
  tools?: string[]
}

export interface Delta {
  parent: string | null
  channel: 'text' | 'thinking'
  text: string
}

export interface FinalResult {
  status: Extract<RunStatus, 'done' | 'failed' | 'waiting'>
  error: string | null
  text: string | null
  report: WorkerReport | null
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  /** A tool call the gate deferred; the session resumes when it is decided. */
  deferred: { id: string; name: string; input: unknown } | null
}

export interface ParseOut {
  events: NormEvent[]
  deltas: Delta[]
  patch?: { sessionId?: string; model?: string; activity?: string }
  /** Set when the run must be stopped at once (wrong login, paid overage). */
  fatal?: string
  final?: FinalResult
  /** Engine reported a usage limit; resetsAt is epoch seconds when known. */
  limit?: { rejected: boolean; resetsAt: number | null; utilization: number | null; window?: string | null; status?: string }
}

export type LineParser = (line: string) => ParseOut

export interface EngineAdapter {
  engine: Engine
  buildArgs(spec: SpawnSpec): string[]
  /** One parser per run; it may keep small state between lines. */
  createParser(): LineParser
  /** For engines that take standing instructions only as part of the prompt. */
  wrapPrompt?(spec: SpawnSpec, prompt: string): string
  /** True when the CLI reads its prompt from spec.promptFile and stdin is left empty. */
  promptFromFile?: boolean
  /** True when a new session's id is chosen by HeyBotOS and passed in. */
  ownsSessionId?: boolean
}
