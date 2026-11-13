// The gate's rulebook. Workers run without asking, except for three kinds of action that reach
// outside this computer: connecting to a server that is not on the allowlist, running a deploy or
// publish command, and calling a connector tool that changes something.
//
// This is a seatbelt against mistakes, not a sandbox: a worker that calls /usr/bin/ssh by its full
// path is not stopped here. The worker's instructions tell it not to work around the gate.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Home } from '../home.ts'

export interface GateConfig {
  /** Hosts workers may reach without asking. "*.example.com" matches sub-domains. */
  allowedHosts: string[]
  /** Connector tools that may change things without asking, as "server/tool" or "server/*". */
  alwaysAllowTools: string[]
  /** Extra regular expressions; a shell command matching one needs approval. */
  askCommandPatterns: string[]
  /** How long a yes for a host stays valid, so a deploy that makes several connections asks once. */
  hostGrantMinutes: number
  /** Let workers use the owner's SSH agent, so keys with a passphrase work for them too. Which servers they may reach is still decided above. */
  sshAgent: boolean
}

const DEFAULTS: GateConfig = {
  // Code hosting is reached by ordinary git commands all the time.
  allowedHosts: ['localhost', '127.0.0.1', '::1', 'github.com', 'gitlab.com', 'bitbucket.org'],
  alwaysAllowTools: [],
  askCommandPatterns: [],
  hostGrantMinutes: 15,
  sshAgent: true,
}

export function loadGateConfig(home: Home): GateConfig {
  const path = join(home.configDir, 'gate.json')
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n')
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<GateConfig>) }
  } catch (e) {
    throw new Error(`Gate settings file ${path} is not valid JSON: ${(e as Error).message}`)
  }
}

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'ask'; kind: 'host' | 'tool' | 'command'; key: string; summary: string; detail: string }

// ── reading shell commands ───────────────────────────────────────────────────────────────────

/** Split a command line into simple commands, each a list of words. Quotes are honoured, nothing is expanded. */
export function splitCommands(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      has = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') endCommand()
    else if (c === '$' && line[i + 1] === '(') {
      endCommand()
      i++
    } else {
      word += c
      has = true
    }
  }
  endCommand()
  return commands
}

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'env', 'nice', 'caffeinate', 'xargs', 'stdbuf', 'unbuffer'])
const SSH_TAKES_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const SHELL_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

/** A program's name without its folder, and without the ending Windows gives programs (ssh.exe is ssh). */
const bare = (word: string) => word.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '')

function program(words: string[]): { name: string; args: string[] } | null {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || SHELL_WORDS.has(w)) i++
    else if (WRAPPERS.has(bare(w))) {
      i++
      // "timeout 30 cmd", "nice -n 5 cmd": skip the wrapper's own options and numbers.
      while (i < words.length && (/^-/.test(words[i]!) || /^\d+[smhd]?$/.test(words[i]!))) i++
    } else if (w === 'timeout') {
      i++
      while (i < words.length && (/^-/.test(words[i]!) || /^\d+(\.\d+)?[smhd]?$/.test(words[i]!))) i++
    } else break
  }
  if (i >= words.length) return null
  return { name: bare(words[i]!), args: words.slice(i + 1) }
}

function cleanHost(target: string): string {
  let h = target.replace(/^(ssh|sftp|rsync|scp):\/\//, '')
  h = h.split('/')[0]!
  h = h.includes('@') ? h.slice(h.lastIndexOf('@') + 1) : h
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')) // [ipv6]:port
  return h.replace(/:\d*$/, '').toLowerCase()
}

/** Every remote host a shell command line would connect to with ssh, scp, sftp, rsync or mosh. */
export function remoteHosts(line: string, depth = 0): string[] {
  const hosts: string[] = []
  for (const words of splitCommands(line)) {
    const p = program(words)
    if (!p) continue
    if (p.name === 'ssh' || p.name === 'mosh' || p.name === 'sftp' || p.name === 'ssh-copy-id') {
      for (let i = 0; i < p.args.length; i++) {
        const a = p.args[i]!
        if (a.startsWith('-')) {
          // "-p 22" takes a value, "-p22" carries it, "-v" has none.
          if (a.length === 2 && SSH_TAKES_VALUE.has(a[1]!)) i++
          continue
        }
        hosts.push(cleanHost(a.includes(':') && !a.includes('://') && p.name === 'sftp' ? a.slice(0, a.indexOf(':')) : a))
        // What follows the host is the command that runs over there; it is not ours to read.
        break
      }
    } else if (p.name === 'scp' || p.name === 'rsync') {
      for (const a of p.args) {
        if (a.startsWith('-')) continue
        if (/^(rsync|scp|ssh):\/\//.test(a)) hosts.push(cleanHost(a))
        // host:path, with the colon before any slash; "C:\..." and "./a:b" are local.
        else if (/^[^/\s:]{2,}:/.test(a) && !a.startsWith('.')) hosts.push(cleanHost(a.slice(0, a.indexOf(':'))))
      }
    } else if (SHELLS.has(p.name) && depth < 3) {
      const c = p.args.indexOf('-c')
      const lc = p.args.findIndex((a) => /^-[a-z]*c$/.test(a))
      const at = c >= 0 ? c : lc
      if (at >= 0 && p.args[at + 1]) hosts.push(...remoteHosts(p.args[at + 1]!, depth + 1))
    }
  }
  return [...new Set(hosts.filter(Boolean))]
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase()
  return allowed.some((a) => {
    const rule = a.toLowerCase()
    return rule.startsWith('*.') ? h.endsWith(rule.slice(1)) : h === rule
  })
}

// Commands that publish or deploy by themselves, whatever host they end up talking to.
const DEPLOY_COMMANDS: Array<[RegExp, string]> = [
  [/^(vercel|netlify|firebase|wrangler|fly|flyctl|railway|heroku|surge)$/, '(deploy|--prod|publish|release|container:release)'],
  [/^(dep|envoy|cap|kamal|ansible-playbook|terraform|pulumi|kubectl|helm)$/, '(deploy|run|apply|up|upgrade|install|rollout|production|prod)'],
  [/^(npm|pnpm|yarn|bun)$/, '^(publish)$'],
  [/^(twine)$/, '^(upload)$'],
  [/^(gem)$/, '^(push)$'],
  [/^(cargo)$/, '^(publish)$'],
  [/^(docker|podman)$/, '^(push)$'],
  [/^(gh)$/, '^(release)$'],
]

export function deployCommand(line: string): string | null {
  for (const words of splitCommands(line)) {
    const p = program(words)
    if (!p) continue
    for (const [prog, verb] of DEPLOY_COMMANDS) {
      if (!prog.test(p.name)) continue
      const re = new RegExp(verb)
      if (p.args.some((a) => re.test(a))) return [p.name, ...p.args].join(' ')
    }
    if (/^deploy(\.sh|\.php|\.py|\.js)?$/.test(p.name)) return [p.name, ...p.args].join(' ')
  }
  return null
}

// ── connector tools ──────────────────────────────────────────────────────────────────────────

const READ_VERBS = 'get|list|search|find|read|query|whoami|tail|calculate|check|fetch|describe|recent|related|suggest|preview|status|fuzzy_search|count|show|view|lookup|download|guide'
const READS = new RegExp(`^(${READ_VERBS})(_|$)`)
/** One word in front of the verb that says which part of a system the tool belongs to: "ledger_list_accounts". */
const AREA_THEN_READ = new RegExp(`^[a-z0-9]+_(?=(${READ_VERBS})(_|$))`)
/** Names that are a thing to look at rather than a verb: "production_dashboard". */
const READ_THINGS = /(^|_)(dashboard|overview|summary|stats)$/

/**
 * Does this connector tool only look, or does it change something? Decided from the name, and
 * strict on purpose: a tool that is not clearly a read is treated as a change and asks first.
 */
export function connectorReads(tool: string): boolean {
  const name = tool.toLowerCase().replace(/-/g, '_')
  if (READS.test(name) || READ_THINGS.test(name)) return true
  // "bulk_delete_orders" stays a change: only a read verb right after the first word counts.
  return READS.test(name.replace(AREA_THEN_READ, ''))
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function decide(cfg: GateConfig, tool: string, input: Record<string, unknown>): Verdict {
  if (tool === 'Bash' || tool === 'shell') {
    const command = String(input.command ?? '')
    const host = remoteHosts(command).find((h) => !hostAllowed(h, cfg.allowedHosts))
    if (host) return { decision: 'ask', kind: 'host', key: host, summary: `Connect to the server ${host}`, detail: command }
    const deploy = deployCommand(command)
    if (deploy) return { decision: 'ask', kind: 'command', key: command, summary: `Run a deploy or publish command: ${short(deploy, 80)}`, detail: command }
    for (const pattern of cfg.askCommandPatterns) {
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        continue
      }
      if (re.test(command)) return { decision: 'ask', kind: 'command', key: command, summary: `Run a command you marked as needing approval: ${short(command, 80)}`, detail: command }
    }
    return { decision: 'allow' }
  }

  // The ssh/scp/rsync wrappers on the worker's PATH report the real program and its arguments.
  if (tool.startsWith('shim:')) {
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : []
    const line = [tool.slice(5), ...argv.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a))].join(' ')
    const host = remoteHosts(line).find((h) => !hostAllowed(h, cfg.allowedHosts))
    if (host) return { decision: 'ask', kind: 'host', key: host, summary: `Connect to the server ${host}`, detail: line }
    return { decision: 'allow' }
  }

  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__')
    const name = rest.join('__')
    // HeyBotOS's own tools are how the manager works; they carry their own checks.
    if (server === 'heybotos') return { decision: 'allow' }
    if (connectorReads(name)) return { decision: 'allow' }
    if (cfg.alwaysAllowTools.includes(`${server}/${name}`) || cfg.alwaysAllowTools.includes(`${server}/*`)) return { decision: 'allow' }
    const detail = JSON.stringify(input, null, 2)
    return {
      decision: 'ask',
      kind: 'tool',
      key: `${tool}\n${JSON.stringify(input)}`,
      summary: `Use ${server} to ${name.replace(/[-_]/g, ' ')}`,
      detail: detail.length > 4000 ? `${detail.slice(0, 4000)}\n…` : detail,
    }
  }

  return { decision: 'allow' }
}

/** The servers named in the owner's SSH config: names only, never keys or addresses. */
export function knownServers(): string[] {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return []
  const names = new Set<string>()
  try {
    for (const m of readFileSync(path, 'utf8').matchAll(/^\s*Host\s+(.+)$/gim)) {
      for (const name of m[1]!.split(/\s+/)) if (name && !/[*?!]/.test(name)) names.add(name.toLowerCase())
    }
  } catch {
    return []
  }
  return [...names].sort()
}
