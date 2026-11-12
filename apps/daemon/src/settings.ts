// Settings the owner changes from the app (or asks the manager to change). Each change is checked,
// written to the matching file in ~/heybotos/config, and applied to the running daemon at once.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine, SettingsPatch, SettingsView, TaskKind } from '@heybotos/protocol'
import type { Approvals } from './approvals.ts'
import type { ConnectorRegistry } from './connect/registry.ts'
import type { Home } from './home.ts'
import type { Manager } from './manager.ts'
import type { Registry } from './registry.ts'
import type { Router } from './router.ts'
import type { Supervisor } from './engines/supervisor.ts'
import { knownServers } from './policy/gate.ts'

const KINDS: TaskKind[] = ['build', 'review', 'research', 'write', 'ops', 'other']
const ENGINES: Engine[] = ['claude', 'codex', 'grok']

export class Settings {
  private home: Home
  private manager: Manager
  private approvals: Approvals
  private router: Router
  private registry: Registry
  private connectors: ConnectorRegistry
  private supervisor: Supervisor

  constructor(deps: { home: Home; manager: Manager; approvals: Approvals; router: Router; registry: Registry; connectors: ConnectorRegistry; supervisor: Supervisor }) {
    this.home = deps.home
    this.manager = deps.manager
    this.approvals = deps.approvals
    this.router = deps.router
    this.registry = deps.registry
    this.connectors = deps.connectors
    this.supervisor = deps.supervisor
    // "Always allow this server" from an inbox card is a settings change like any other.
    this.approvals.onAlways = (host) => {
      if (!this.approvals.cfg.allowedHosts.includes(host)) this.apply({ gate: { allowedHosts: [...this.approvals.cfg.allowedHosts, host] } })
    }
  }

  read(): SettingsView {
    const c = this.home.config
    return {
      general: { maxWorkers: c.maxWorkers, notifications: c.notifications, projectRoots: [...c.projectRoots] },
      manager: { name: this.manager.name(), model: c.manager.model, effort: c.manager.effort, batchSeconds: c.manager.batchSeconds },
      engines: { claude: { model: c.engines.claude.model, effort: c.engines.claude.effort }, codex: { model: c.engines.codex.model, effort: c.engines.codex.effort }, grok: { model: c.engines.grok.model, effort: c.engines.grok.effort } },
      routing: { mode: this.router.cfg.mode, pool: [...this.router.cfg.pool], byKind: { ...this.router.cfg.byKind }, fallback: this.router.cfg.fallback, headroom: { ...this.router.cfg.headroom } },
      gate: { allowedHosts: [...this.approvals.cfg.allowedHosts], alwaysAllowTools: [...this.approvals.cfg.alwaysAllowTools], askCommandPatterns: [...this.approvals.cfg.askCommandPatterns], hostGrantMinutes: this.approvals.cfg.hostGrantMinutes, sshAgent: this.approvals.cfg.sshAgent, knownServers: knownServers() },
      connectors: this.connectors.names(),
      paths: { home: this.home.root, config: this.home.configDir },
    }
  }

  /** Apply a change. Throws with a plain sentence when a value does not make sense; nothing is saved then. */
  apply(patch: SettingsPatch): SettingsView {
    const c = this.home.config
    const list = (v: unknown, what: string, max = 200): string[] => {
      if (!Array.isArray(v)) throw new Error(`${what} must be a list.`)
      return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, max)
    }
    const word = (v: unknown, what: string): string => {
      const s = String(v ?? '').trim()
      if (!/^[A-Za-z0-9._:\-[\]]*$/.test(s)) throw new Error(`${what} can only contain letters, digits and . _ : - [ ]`)
      return s
    }
    const next = structuredClone({ config: c, routing: this.router.cfg, gate: this.approvals.cfg })
    let rename: string | null = null
    let rescan = false

    const g = patch.general
    if (g) {
      if (g.maxWorkers !== undefined) {
        const n = Number(g.maxWorkers)
        if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error('Workers at once must be a whole number from 1 to 12.')
        next.config.maxWorkers = n
      }
      if (g.notifications !== undefined) next.config.notifications = g.notifications === true
      if (g.projectRoots !== undefined) {
        const roots = list(g.projectRoots, 'Project folders', 20)
        if (!roots.length) throw new Error('Name at least one folder that holds your projects.')
        for (const r of roots) if (!r.startsWith('/') && !r.startsWith('~')) throw new Error(`"${r}" is not a full folder path. Start it with / or ~.`)
        rescan = JSON.stringify(roots) !== JSON.stringify(c.projectRoots)
        next.config.projectRoots = roots
      }
    }
    const m = patch.manager
    if (m) {
      if (m.name !== undefined) rename = String(m.name)
      if (m.model !== undefined) next.config.manager.model = word(m.model, 'The model')
      if (m.effort !== undefined) next.config.manager.effort = word(m.effort, 'The effort level')
      if (m.batchSeconds !== undefined) {
        const n = Number(m.batchSeconds)
        if (!Number.isFinite(n) || n < 0 || n > 600) throw new Error('The gathering time must be between 0 and 600 seconds.')
        next.config.manager.batchSeconds = Math.round(n)
      }
    }
    for (const e of ENGINES) {
      const p = patch.engines?.[e]
      if (!p) continue
      if (p.model !== undefined) next.config.engines[e].model = word(p.model, 'The model')
      if (p.effort !== undefined) next.config.engines[e].effort = word(p.effort, 'The effort level')
    }
    const r = patch.routing
    if (r) {
      if (r.mode !== undefined) {
        if (r.mode !== 'balanced' && r.mode !== 'rules') throw new Error('The routing mode is either "balanced" or "rules".')
        next.routing.mode = r.mode
      }
      if (r.pool !== undefined) {
        const pool = list(r.pool, 'The engines that share the work') as Engine[]
        for (const e of pool) if (!ENGINES.includes(e)) throw new Error(`"${e}" is not an engine. Use claude, codex or grok.`)
        if (!pool.length) throw new Error('At least one engine has to take work.')
        next.routing.pool = pool
      }
      for (const k of KINDS) {
        const e = r.byKind?.[k]
        if (e === undefined) continue
        if (!ENGINES.includes(e)) throw new Error(`"${e}" is not an engine. Use claude, codex or grok.`)
        next.routing.byKind[k] = e
      }
      if (r.fallback !== undefined) next.routing.fallback = r.fallback === true
      for (const e of ENGINES) {
        const h = r.headroom?.[e]
        if (h === undefined) continue
        const n = Number(h)
        if (!Number.isFinite(n) || n < 0.5 || n > 1) throw new Error('The hold-back mark must be between 50% and 100%.')
        next.routing.headroom[e] = Math.round(n * 100) / 100
      }
    }
    const gate = patch.gate
    if (gate) {
      if (gate.allowedHosts !== undefined) {
        const hosts = list(gate.allowedHosts, 'Servers').map((h) => h.toLowerCase())
        for (const h of hosts) if (!/^(\*\.)?[a-z0-9:]([a-z0-9.:-]*[a-z0-9:])?$/.test(h)) throw new Error(`"${h}" does not look like a server name.`)
        next.gate.allowedHosts = hosts
      }
      if (gate.alwaysAllowTools !== undefined) {
        const tools = list(gate.alwaysAllowTools, 'Connector tools')
        for (const t of tools) if (!/^[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+|\*)$/.test(t)) throw new Error(`Write connector tools as connector/tool, or connector/* for all of one connector. "${t}" is not that.`)
        next.gate.alwaysAllowTools = tools
      }
      if (gate.askCommandPatterns !== undefined) {
        const patterns = list(gate.askCommandPatterns, 'Command patterns', 50)
        for (const p of patterns) {
          try {
            new RegExp(p)
          } catch {
            throw new Error(`"${p}" is not a valid pattern.`)
          }
        }
        next.gate.askCommandPatterns = patterns
      }
      if (gate.sshAgent !== undefined) next.gate.sshAgent = gate.sshAgent === true
      if (gate.hostGrantMinutes !== undefined) {
        const n = Number(gate.hostGrantMinutes)
        if (!Number.isFinite(n) || n < 1 || n > 240) throw new Error('A yes for a server must last between 1 and 240 minutes.')
        next.gate.hostGrantMinutes = Math.round(n)
      }
    }

    // Everything checked out: rename, save, and apply to the running daemon.
    if (rename !== null) this.manager.rename(rename)
    Object.assign(c, next.config)
    Object.assign(this.router.cfg, next.routing)
    Object.assign(this.approvals.cfg, next.gate)
    writeFileSync(join(this.home.configDir, 'heybotos.json'), JSON.stringify(c, null, 2) + '\n')
    writeFileSync(join(this.home.configDir, 'routing.json'), JSON.stringify(this.router.cfg, null, 2) + '\n')
    writeFileSync(join(this.home.configDir, 'gate.json'), JSON.stringify(this.approvals.cfg, null, 2) + '\n')
    if (rescan) void this.registry.scan().catch(() => {})
    this.supervisor.nudge()
    return this.read()
  }
}
