// Talking to a connector (an MCP server) from the daemon: either a program on this machine
// (stdio) or a web address (HTTP). The daemon holds the credentials; workers never see them.
import type { ChildProcess } from 'node:child_process'
import { childEnv } from '../engines/env.ts'
import { startProgram } from '../platform.ts'

export interface ToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ConnectorDef {
  name: string
  transport: 'stdio' | 'http'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** For a connector signed in to through the browser: the current token, renewed first when asked to. */
  bearer?: (renew: boolean) => Promise<string | null>
}

export interface CallResult {
  content: unknown[]
  isError: boolean
}

interface Rpc {
  id?: number | string | null
  result?: any
  error?: { code: number; message: string }
  method?: string
}

const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'heybotos', version: '1' } }

abstract class Client {
  protected ready: Promise<void> | null = null
  protected abstract send(method: string, params?: unknown, notification?: boolean): Promise<any>
  abstract close(): void

  private async start(): Promise<void> {
    await this.send('initialize', INIT)
    await this.send('notifications/initialized', undefined, true)
  }

  protected connect(): Promise<void> {
    this.ready ??= this.start().catch((e) => {
      this.ready = null
      throw e
    })
    return this.ready
  }

  async listTools(): Promise<ToolInfo[]> {
    await this.connect()
    const tools: ToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = await this.send('tools/list', cursor ? { cursor } : {})
      for (const t of r?.tools ?? []) tools.push({ name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object' } })
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: unknown): Promise<CallResult> {
    await this.connect()
    const r = await this.send('tools/call', { name, arguments: args ?? {} })
    return { content: Array.isArray(r?.content) ? r.content : [{ type: 'text', text: JSON.stringify(r ?? null) }], isError: r?.isError === true }
  }
}

/** A connector that is a program: one JSON-RPC message per line on its stdin and stdout. */
export class StdioClient extends Client {
  private def: ConnectorDef
  private child: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(def: ConnectorDef) {
    super()
    this.def = def
  }

  private proc(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child
    const child = startProgram(this.def.command!, this.def.args ?? [], { env: childEnv({ runId: `connector:${this.def.name}`, extra: this.def.env ?? {} }), stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        let msg: Rpc
        try {
          msg = JSON.parse(line)
        } catch {
          continue // a program that prints something else on stdout is tolerated
        }
        const w = typeof msg.id === 'number' ? this.waiting.get(msg.id) : undefined
        if (!w) continue
        this.waiting.delete(msg.id as number)
        clearTimeout(w.timer)
        if (msg.error) w.reject(new Error(msg.error.message))
        else w.resolve(msg.result)
      }
    })
    const fail = (why: string) => {
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer)
        w.reject(new Error(why))
      }
      this.waiting.clear()
      this.child = null
      this.ready = null
    }
    child.on('exit', () => fail(`The connector program "${this.def.name}" stopped.`))
    child.on('error', (e) => fail(`The connector program "${this.def.name}" could not be started: ${e.message}`))
    child.stdin!.on('error', () => {})
    this.child = child
    return child
  }

  protected send(method: string, params?: unknown, notification = false): Promise<any> {
    const child = this.proc()
    if (notification) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
      return Promise.resolve(null)
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waiting.delete(id)
          reject(new Error(`The connector "${this.def.name}" did not answer in time.`))
        },
        method === 'tools/call' ? 120_000 : 30_000,
      )
      this.waiting.set(id, { resolve, reject, timer })
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close(): void {
    this.child?.kill()
    this.child = null
    this.ready = null
  }
}

/** A connector at a web address (MCP "streamable HTTP"): one POST per message, answer as JSON or as an event stream. */
export class HttpClient extends Client {
  private def: ConnectorDef
  private nextId = 1
  private session: string | null = null

  constructor(def: ConnectorDef) {
    super()
    this.def = def
  }

  private async post(body: string, renew: boolean): Promise<Response> {
    const token = this.def.bearer ? await this.def.bearer(renew) : null
    return fetch(this.def.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(this.def.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
      signal: AbortSignal.timeout(120_000),
    }).catch((e: Error) => {
      throw new Error(e.name === 'TimeoutError' ? `The connector "${this.def.name}" did not answer in time.` : `Nothing answers at the address of the connector "${this.def.name}". Check the address, and that this Mac is online.`)
    })
  }

  protected async send(method: string, params?: unknown, notification = false): Promise<any> {
    const id = notification ? undefined : this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params })
    let res = await this.post(body, false)
    // A token that ran out early is renewed once and the request sent again.
    if (res.status === 401 && this.def.bearer) res = await this.post(body, true)
    const session = res.headers.get('mcp-session-id')
    if (session) this.session = session
    if (res.status === 401 || res.status === 403) throw new Error(`The connector "${this.def.name}" refused the sign-in it was given (HTTP ${res.status}). Sign in to it, or give it a sign-in header.`)
    if (notification) return null
    if (!res.ok) throw new Error(`The connector "${this.def.name}" answered with an error (HTTP ${res.status}).`)
    const text = await res.text()
    let msg: Rpc | undefined
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // The answer is the event whose id is ours; other events are progress or server requests.
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          const m = JSON.parse(data) as Rpc
          if (m.id === id) msg = m
        } catch {
          /* skip */
        }
      }
    } else {
      msg = JSON.parse(text) as Rpc
    }
    if (!msg) throw new Error(`The connector "${this.def.name}" gave no answer.`)
    if (msg.error) throw new Error(msg.error.message)
    return msg.result
  }

  close(): void {
    this.session = null
    this.ready = null
  }
}

export function clientFor(def: ConnectorDef): Client {
  return def.transport === 'stdio' ? new StdioClient(def) : new HttpClient(def)
}
export type { Client }
