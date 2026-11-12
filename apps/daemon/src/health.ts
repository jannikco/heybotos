// Are the two CLIs installed and signed in with a subscription? Asked of the CLIs themselves.
import { execFile } from 'node:child_process'
import type { Engine, EngineHealth } from '@heybotos/protocol'
import { findBin, type Home } from './home.ts'
import { childEnv } from './engines/env.ts'

function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: childEnv({ runId: 'health' }), timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    })
  })
}

async function check(home: Home, engine: Engine): Promise<EngineHealth> {
  const bin = findBin(home.config.engines[engine].bin)
  if (!bin) return { engine, found: false, bin: null, version: null, loggedIn: false, detail: 'Not installed, or not on the PATH.' }
  const version = (await run(bin, ['--version'])).out.split('\n')[0] ?? null

  if (engine === 'claude') {
    const r = await run(bin, ['auth', 'status'])
    try {
      const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; loginExpiresAt?: string }
      const subscription = j.loggedIn === true && j.authMethod === 'claude.ai'
      const until = j.loginExpiresAt ? `, login valid until ${j.loginExpiresAt.slice(0, 10)}` : ''
      return {
        engine,
        found: true,
        bin,
        version,
        loggedIn: subscription,
        detail: subscription
          ? `Signed in with the ${j.subscriptionType ?? 'subscription'} plan${until}.`
          : j.loggedIn
            ? `Signed in, but not with a subscription (${j.authMethod}). Workers will not start.`
            : 'Not signed in. Run "claude auth login" in a terminal.',
      }
    } catch {
      return { engine, found: true, bin, version, loggedIn: false, detail: r.out.slice(0, 200) || 'Could not read the login state.' }
    }
  }

  if (engine === 'grok') {
    // Grok has no "am I signed in" command; listing models only works with a login.
    const r = await run(bin, ['models'])
    return { engine, found: true, bin, version, loggedIn: r.ok, detail: r.ok ? 'Signed in.' : 'Not signed in. Run "grok login" in a terminal.' }
  }

  const r = await run(bin, ['login', 'status'])
  const subscription = /logged in using chatgpt/i.test(r.out)
  return {
    engine,
    found: true,
    bin,
    version,
    loggedIn: subscription,
    detail: subscription ? 'Signed in with the ChatGPT plan.' : r.out.split('\n')[0]?.slice(0, 200) || 'Not signed in. Run "codex login" in a terminal.',
  }
}

let cache: { at: number; value: EngineHealth[] } | null = null

export async function engineHealth(home: Home, fresh = false): Promise<EngineHealth[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value
  const value = await Promise.all([check(home, 'claude'), check(home, 'codex'), check(home, 'grok')])
  cache = { at: Date.now(), value }
  return value
}
