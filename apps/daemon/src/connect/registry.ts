// HeyBotOS's own connectors. Set one up here once and every engine's workers can use it, through the
// gateway: the worker talks to HeyBotOS, HeyBotOS talks to the connector. Addresses, keys and tokens stay
// in the daemon; a worker only ever holds a pass for its own run.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ConnectorView } from '@heybotos/protocol'
import type { Db } from '../db.ts'
import type { Home } from '../home.ts'
import { connectorReads } from '../policy/gate.ts'
import { clientFor, type Client, type ConnectorDef, type ToolInfo } from './client.ts'
import { authorizeUrl, discover, exchange, newVerifier, register, renew, type OAuthServer, type OAuthTokens } from './oauth.ts'

interface Row {
  name: string
  transport: 'stdio' | 'http'
  url: string | null
  headers: string
  command: string | null
  args: string
  env: string
  enabled: number
  source: string
  tools: string
  last_error: string | null
  checked_at: number | null
  created_at: number
  oauth: string | null
  trusted: number
}

interface PendingSignIn {
  name: string
  server: OAuthServer
  client: { clientId: string; clientSecret: string | null }
  redirectUri: string
  verifier: string
  at: number
}

/**
 * The name a connector is kept under, made from what the owner typed. It becomes part of the name of
 * every tool the connector offers, and the engines take only letters, digits and single dashes or
 * underscores there (Grok drops a tool with a double underscore). So spaces and anything else turn
 * into one dash: "My CRM (prod)" is kept as "My-CRM-prod".
 */
export function connectorName(typed: string): string {
  const tidy = (t: string) => t.replace(/^[-_]+|[-_]+$/g, '')
  const plain = typed
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'oe')
    .replace(/[åÅ]/g, 'aa')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, (run) => (run.includes('-') ? '-' : '_'))
  return tidy(tidy(plain).slice(0, 40))
}
const RESERVED = new Set(['hub', 'heybotos'])

export class ConnectorRegistry {
  private db: Db
  private home: Home
  private clients = new Map<string, Client>()
  private signIns = new Map<string, PendingSignIn>()

  constructor(home: Home, db: Db) {
    this.home = home
    this.db = db
  }

  private row(name: string): Row | undefined {
    return this.db.get<Row>('select * from connectors where name = ?', name)
  }

  private def(r: Row): ConnectorDef {
    return { name: r.name, transport: r.transport, url: r.url ?? undefined, headers: JSON.parse(r.headers), command: r.command ?? undefined, args: JSON.parse(r.args), env: JSON.parse(r.env), ...(r.oauth ? { bearer: (again: boolean) => this.bearer(r.name, again) } : {}) }
  }

  /** The token of a connector signed in to through the browser, renewed when it is about to run out or was refused. */
  private async bearer(name: string, again: boolean): Promise<string | null> {
    const r = this.row(name)
    if (!r?.oauth) return null
    let t = JSON.parse(r.oauth) as OAuthTokens
    if (again || (t.expiresAt !== null && t.expiresAt - Date.now() < 60_000)) {
      try {
        t = await renew(t)
        this.db.run('update connectors set oauth = ? where name = ?', JSON.stringify(t), name)
      } catch {
        if (again) throw new Error(`The sign-in to "${name}" has run out. Sign in to it again in Settings.`)
      }
    }
    return t.access
  }

  /** Start a sign-in through the browser: returns the page the owner must open. */
  async startSignIn(name: string, base: string): Promise<string> {
    const r = this.row(name)
    if (!r) throw new Error('No such connector.')
    if (r.transport !== 'http' || !r.url) throw new Error('Only a connector at a web address can be signed in to through the browser.')
    const redirectUri = `${base}/oauth/callback`
    const server = await discover(r.url)
    const client = await register(server, redirectUri)
    const { verifier, challenge, state } = newVerifier()
    for (const [k, p] of this.signIns) if (Date.now() - p.at > 15 * 60_000) this.signIns.delete(k)
    this.signIns.set(state, { name, server, client, redirectUri, verifier, at: Date.now() })
    return authorizeUrl(server, client.clientId, redirectUri, state, challenge)
  }

  /** The browser came back: swap its code for tokens and ask the connector what it offers. */
  async finishSignIn(state: string, code: string): Promise<ConnectorView> {
    const p = this.signIns.get(state)
    if (!p || Date.now() - p.at > 15 * 60_000) throw new Error('This sign-in was not started here, or took too long. Start it again from Settings.')
    this.signIns.delete(state)
    const tokens = await exchange(p.server, p.client, p.redirectUri, code, p.verifier)
    this.db.run('update connectors set oauth = ? where name = ?', JSON.stringify(tokens), p.name)
    this.drop(p.name)
    return this.refresh(p.name)
  }

  /** What the app may see: never the headers, the environment or anything else that could be a credential. */
  private view(r: Row): ConnectorView {
    const tools = JSON.parse(r.tools) as ToolInfo[]
    return {
      name: r.name,
      transport: r.transport,
      where: r.transport === 'http' ? (r.url ?? '').replace(/^(https?:\/\/[^/?#]+).*$/, '$1') : [r.command ?? '', ...(JSON.parse(r.args) as string[]).filter((a) => !a.startsWith('-')).slice(0, 1)].map((p) => basename(p)).join(' '),
      enabled: r.enabled === 1,
      source: r.source,
      signedIn: r.oauth !== null,
      trusted: r.trusted === 1,
      needsSignIn: r.transport === 'http' && r.enabled === 1 && /HTTP 401|has run out/.test(r.last_error ?? ''),
      tools: tools.map((t) => t.name),
      asks: tools.map((t) => t.name).filter((n) => !connectorReads(n)),
      error: r.last_error,
      checkedAt: r.checked_at,
    }
  }

  list(): ConnectorView[] {
    return this.db.all<Row>('select * from connectors order by name').map((r) => this.view(r))
  }

  /** Names a task may ask for. */
  names(): string[] {
    return this.db.all<{ name: string }>('select name from connectors where enabled = 1 order by name').map((r) => r.name)
  }

  check(names: string[]): string[] {
    const known = new Set(this.names())
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    const unknown = clean.filter((n) => !known.has(n))
    if (unknown.length) throw new Error(`No connector called ${unknown.map((n) => `"${n}"`).join(', ')}. Set up: ${this.names().join(', ') || 'none yet (add them in Settings)'}.`)
    return clean
  }

  save(input: { name: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; source?: string; trusted?: boolean }): ConnectorView {
    const name = connectorName(input.name)
    if (!name) throw new Error('A connector name needs at least one letter or digit, like "shop" or "My CRM".')
    if (RESERVED.has(name.toLowerCase())) throw new Error(`"${name}" is a name HeyBotOS uses itself. Pick another.`)
    const url = input.url?.trim() || null
    const command = input.command?.trim() || null
    if (!url && !command) throw new Error('A connector needs a web address, or a command to run.')
    if (url && !/^https?:\/\//.test(url)) throw new Error('The web address must start with http:// or https://')
    const existing = this.row(name)
    const fields = [url ? 'http' : 'stdio', url, JSON.stringify(input.headers ?? (existing ? JSON.parse(existing.headers) : {})), command, JSON.stringify(input.args ?? (existing ? JSON.parse(existing.args) : [])), JSON.stringify(input.env ?? (existing ? JSON.parse(existing.env) : {})), (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0] as const
    if (existing) this.db.run('update connectors set transport = ?, url = ?, headers = ?, command = ?, args = ?, env = ?, enabled = ?, oauth = case when url is ? then oauth else null end where name = ?', ...fields, url, name)
    else this.db.run('insert into connectors (transport, url, headers, command, args, env, enabled, name, source, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...fields, name, input.source ?? 'added here', Date.now())
    if (input.trusted !== undefined) this.db.run('update connectors set trusted = ? where name = ?', input.trusted ? 1 : 0, name)
    this.drop(name)
    return this.view(this.row(name)!)
  }

  /** Whether the owner trusts what this connector returns enough to leave a worker its shell. */
  setTrusted(name: string, trusted: boolean): ConnectorView {
    if (!this.row(name)) throw new Error('No such connector.')
    this.db.run('update connectors set trusted = ? where name = ?', trusted ? 1 : 0, name)
    return this.view(this.row(name)!)
  }

  /** True when every one of these connectors is trusted (and there is at least one). */
  allTrusted(names: string[]): boolean {
    return names.length > 0 && names.every((n) => this.row(n)?.trusted === 1)
  }

  setEnabled(name: string, enabled: boolean): ConnectorView {
    if (!this.row(name)) throw new Error('No such connector.')
    this.db.run('update connectors set enabled = ? where name = ?', enabled ? 1 : 0, name)
    return this.view(this.row(name)!)
  }

  remove(name: string): void {
    this.drop(name)
    this.db.run('delete from connectors where name = ?', name)
  }

  private drop(name: string): void {
    this.clients.get(name)?.close()
    this.clients.delete(name)
  }

  /**
   * Bring over the connectors already set up for Claude Code: the owner's own, the ones their plugins
   * bring (a browser, a framework's helper), and the ones written down in a project's folder. Ones
   * with the same name here are left as they are. Workers never get Claude Code's own connectors
   * directly; this is how they reach them.
   */
  importFromClaude(projectDirs: string[] = []): { added: string[]; skipped: string[] } {
    const f = this.home.config.connectorsFile
    const path = f === '~' ? homedir() : f.startsWith('~/') ? join(homedir(), f.slice(2)) : f
    const added: string[] = []
    const skipped: string[] = []
    type Defs = Record<string, Record<string, any>>
    const read = (file: string): Record<string, any> | null => {
      try {
        return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>) : null
      } catch {
        return null
      }
    }
    const take = (servers: unknown, source: string, root?: string) => {
      if (servers === null || typeof servers !== 'object') return
      // A plugin names its own folder with a placeholder.
      const here = <T>(v: T): T => (root === undefined ? v : (JSON.parse(JSON.stringify(v).replaceAll('${CLAUDE_PLUGIN_ROOT}', JSON.stringify(root).slice(1, -1))) as T))
      for (const [given, raw] of Object.entries(servers as Defs)) {
        const name = connectorName(given)
        if (!name || this.row(name) || added.includes(name) || raw === null || typeof raw !== 'object') {
          if (!skipped.includes(given)) skipped.push(given)
          continue
        }
        const s = here(raw)
        try {
          this.save({ name, url: typeof s.url === 'string' ? s.url : undefined, headers: s.headers ?? {}, command: typeof s.command === 'string' ? s.command : undefined, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env ?? {}, source })
          added.push(name)
        } catch {
          skipped.push(given)
        }
      }
    }
    const own = read(path)
    take(own?.mcpServers, 'from Claude Code')
    // Plugins: each installed one may bring connectors in a .mcp.json of its own.
    const plugins = read(join(dirname(path), '.claude', 'plugins', 'installed_plugins.json'))?.plugins as Record<string, Array<{ installPath?: string }>> | undefined
    for (const [id, installs] of Object.entries(plugins ?? {})) {
      for (const install of Array.isArray(installs) ? installs : []) {
        if (typeof install?.installPath !== 'string') continue
        const file = read(join(install.installPath, '.mcp.json'))
        take(file?.mcpServers ?? file, `from the ${id.split('@')[0]} plugin`, install.installPath)
      }
    }
    // Projects: what a project's folder says, and what Claude Code keeps for that folder.
    for (const dir of projectDirs) {
      const file = read(join(dir, '.mcp.json'))
      take(file?.mcpServers ?? null, `from ${basename(dir)}`)
      take(own?.projects?.[dir]?.mcpServers, `from ${basename(dir)}`)
    }
    return { added, skipped }
  }

  /** The first time HeyBotOS runs with connectors of its own, start from the ones Claude Code already has. */
  importOnce(): void {
    if (this.db.get(`select value from meta where key = 'connectors_imported'`)) return
    const { added } = this.importFromClaude()
    this.db.run(`insert into meta (key, value) values ('connectors_imported', ?)`, String(Date.now()))
    if (added.length) console.log(`  Connectors    brought in from Claude Code: ${added.join(', ')}`)
  }

  private client(name: string): Client {
    const r = this.row(name)
    if (!r || r.enabled !== 1) throw new Error(`The connector "${name}" is not set up or is switched off.`)
    let c = this.clients.get(name)
    if (!c) {
      c = clientFor(this.def(r))
      this.clients.set(name, c)
    }
    return c
  }

  /** Ask the connector what it offers, and remember the answer (or why it could not be reached). */
  async refresh(name: string): Promise<ConnectorView> {
    const row = this.row(name)
    if (!row) throw new Error('No such connector.')
    const wasOpen = this.clients.has(name)
    try {
      const tools = await this.client(name).listTools()
      this.db.run('update connectors set tools = ?, last_error = null, checked_at = ? where name = ?', JSON.stringify(tools), Date.now(), name)
      // A program started only to be asked this is not left running; a worker's call starts it again.
      if (!wasOpen && row.transport === 'stdio') this.drop(name)
    } catch (e) {
      this.drop(name)
      this.db.run('update connectors set last_error = ?, checked_at = ? where name = ?', (e as Error).message.slice(0, 400), Date.now(), name)
    }
    return this.view(this.row(name)!)
  }

  /** Ask every connector that has never been asked, in the background. */
  checkNew(): void {
    for (const r of this.db.all<{ name: string }>('select name from connectors where enabled = 1 and checked_at is null')) void this.refresh(r.name).catch(() => {})
  }

  /** The tools of a connector, from what was remembered; asked fresh the first time. */
  async tools(name: string): Promise<ToolInfo[]> {
    const r = this.row(name)
    if (!r) return []
    const cached = JSON.parse(r.tools) as ToolInfo[]
    if (cached.length) return cached
    await this.refresh(name)
    return JSON.parse(this.row(name)!.tools) as ToolInfo[]
  }

  call(name: string, tool: string, args: unknown) {
    return this.client(name).callTool(tool, args)
  }

  close(): void {
    for (const c of this.clients.values()) c.close()
    this.clients.clear()
  }
}
