// Which models each engine offers on the owner's plans, asked of the CLIs themselves, so nothing
// here goes stale when a plan gains a model. Used by the pickers in the app.
import type { Engine, EngineModels } from '@heybotos/protocol'
import { findBin, type Home } from './home.ts'
import { childEnv } from './engines/env.ts'
import { runProgram } from './platform.ts'

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    runProgram(bin, args, { env: childEnv({ runId: 'models' }), timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

// Claude Code takes these short names for the newest model of each line; it has no command that lists them.
const CLAUDE: EngineModels = {
  models: [
    { id: 'fable', name: 'Fable' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultModel: null,
}

async function codex(bin: string): Promise<EngineModels> {
  const out = await run(bin, ['debug', 'models'])
  const empty: EngineModels = { models: [], efforts: ['low', 'medium', 'high'], defaultModel: null }
  if (!out) return empty
  try {
    const list = (JSON.parse(out) as { models?: Array<Record<string, any>> }).models ?? []
    const shown = list.filter((m) => m.visibility === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    const efforts = new Set<string>()
    for (const m of shown) for (const l of m.supported_reasoning_levels ?? []) efforts.add(String(typeof l === 'string' ? l : l.effort))
    return { models: shown.map((m) => ({ id: String(m.slug), name: String(m.display_name ?? m.slug) })), efforts: efforts.size ? [...efforts] : empty.efforts, defaultModel: shown[0] ? String(shown[0].slug) : null }
  } catch {
    return empty
  }
}

async function grok(bin: string): Promise<EngineModels> {
  const out = await run(bin, ['models'])
  const models: EngineModels['models'] = []
  let defaultModel: string | null = null
  for (const m of (out ?? '').matchAll(/^\s*([*-])\s+(\S+)/gm)) {
    models.push({ id: m[2]!, name: m[2]! })
    if (m[1] === '*') defaultModel = m[2]!
  }
  return { models, efforts: ['low', 'medium', 'high'], defaultModel }
}

let cache: { at: number; value: Record<Engine, EngineModels> } | null = null

export async function listModels(home: Home, fresh = false): Promise<Record<Engine, EngineModels>> {
  if (!fresh && cache && Date.now() - cache.at < 10 * 60_000) return cache.value
  const none: EngineModels = { models: [], efforts: [], defaultModel: null }
  const bin = (e: Engine) => findBin(home.config.engines[e].bin)
  const [c, g] = await Promise.all([bin('codex') ? codex(bin('codex')!) : none, bin('grok') ? grok(bin('grok')!) : none])
  const value = { claude: bin('claude') ? CLAUDE : none, codex: c, grok: g }
  cache = { at: Date.now(), value }
  return value
}
