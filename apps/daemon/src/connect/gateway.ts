// The gateway: the one MCP server every worker with connectors talks to, whatever engine it runs on.
// It offers exactly the connectors the worker's task was given, and puts every call through the
// gate: a call that only reads goes straight on; one that changes something waits for the owner.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Approvals } from '../approvals.ts'
import type { Db } from '../db.ts'
import type { Home } from '../home.ts'
import type { ConnectorRegistry } from './registry.ts'

/**
 * Between a connector's name and its tool's, as in "shop--search-orders". Not a double underscore:
 * the CLIs use that themselves to join server and tool, and Grok drops any tool whose name has one.
 */
export const SEP = '--'

interface Rpc {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, any>
}

export class Gateway {
  private home: Home
  private db: Db
  private registry: ConnectorRegistry
  private approvals: Approvals

  constructor(home: Home, db: Db, registry: ConnectorRegistry, approvals: Approvals) {
    this.home = home
    this.db = db
    this.registry = registry
    this.approvals = approvals
  }

  /** Where a run reaches the gateway. The address itself is the pass, so it goes only into that run's own files and arguments. */
  urlFor(runId: string, base: string): string {
    return `${base}/connect/${this.pass(runId)}`
  }

  /** A pass for one run: its id and a signature only the daemon can make. */
  pass(runId: string): string {
    return `${runId}.${createHmac('sha256', this.home.secret).update(`connect:${runId}`).digest('hex')}`
  }

  /** The run a pass belongs to, or null. */
  runOf(pass: string): string | null {
    const dot = pass.indexOf('.')
    if (dot < 1) return null
    const runId = pass.slice(0, dot)
    const want = Buffer.from(this.pass(runId))
    const got = Buffer.from(pass)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    // A pass is only good while its run is alive.
    const run = this.db.get<{ status: string }>('select status from runs where id = ?', runId)
    return run && ['starting', 'running', 'stopping'].includes(run.status) ? runId : null
  }

  /** The connectors this run's task was given. */
  private allowed(runId: string): string[] {
    const row = this.db.get<{ connectors: string | null; extra_json: string | null }>('select t.connectors as connectors, r.extra_json as extra_json from runs r left join tasks t on t.id = r.task_id where r.id = ?', runId)
    if (!row) return []
    const fromTask = row.connectors ? (JSON.parse(row.connectors) as string[]) : []
    const fromRun = row.extra_json ? ((JSON.parse(row.extra_json) as { connectors?: string[] }).connectors ?? []) : []
    const enabled = new Set(this.registry.names())
    return [...new Set([...fromTask, ...fromRun])].filter((n) => enabled.has(n))
  }

  private async answer(runId: string, req: Rpc): Promise<Record<string, unknown> | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } })
    const said = (text: string, isError = true) => reply({ content: [{ type: 'text', text }], isError })
    if (req.id === undefined || req.id === null) return req.method ? null : fail(-32600, 'Not a valid request.')
    switch (req.method) {
      case 'initialize':
        return reply({ protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'heybotos-connect', version: '1' }, instructions: "The owner's connectors, through HeyBotOS. Calls that change something wait for the owner's yes." })
      case 'ping':
        return reply({})
      case 'tools/list': {
        const tools: unknown[] = []
        for (const name of this.allowed(runId)) {
          for (const t of await this.registry.tools(name)) tools.push({ name: `${name}${SEP}${t.name}`, description: `[${name}] ${t.description}`.slice(0, 2000), inputSchema: t.inputSchema })
        }
        return reply({ tools })
      }
      case 'tools/call': {
        const full = String(req.params?.name ?? '')
        const cut = full.indexOf(SEP)
        const connector = cut > 0 ? full.slice(0, cut) : ''
        const tool = cut > 0 ? full.slice(cut + SEP.length) : ''
        if (!connector || !this.allowed(runId).includes(connector)) return said(`This task was not given a connector called "${connector || full}".`)
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>
        // The same gate as every other outward action: reads pass, changes ask.
        const verdict = this.approvals.check(runId, `mcp__${connector}__${tool}`, args)
        if (verdict.decision !== 'allow') return said(verdict.reason ?? 'HeyBotOS did not allow this call.')
        try {
          const r = await this.registry.call(connector, tool, args)
          return reply({ content: r.content, isError: r.isError })
        } catch (e) {
          return said(`The connector "${connector}" failed: ${(e as Error).message}`)
        }
      }
      default:
        return fail(-32601, `Method "${req.method}" is not supported.`)
    }
  }

  async handle(runId: string, body: unknown): Promise<unknown | null> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((r) => this.answer(runId, r as Rpc)))).filter((r) => r !== null)
      return out.length ? out : null
    }
    if (body === null || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read the request.' } }
    return this.answer(runId, body as Rpc)
  }
}
