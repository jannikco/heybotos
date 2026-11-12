#!/usr/bin/env node
// Stands in for ssh, scp, sftp, rsync and mosh on a HeyBotOS worker's PATH. Asks the daemon whether
// the connection may be made, then runs the real program with the same arguments.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const [name, ...argv] = process.argv.slice(2)
// Inside the Mac app this script is run by the app acting as Node. The real program must not inherit that.
delete process.env.ELECTRON_RUN_AS_NODE
const { HEYBOTOS_GATE_URL: url, HEYBOTOS_GATE_TOKEN: token, HEYBOTOS_RUN_ID: runId, HEYBOTOS_SHIM_DIR: shimDir } = process.env

const refuse = (reason) => {
  process.stderr.write(`${reason}\n`)
  process.exit(126)
}

// The real program: the first one on PATH that is not this wrapper.
const real = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((dir) => dir && dir !== shimDir)
  .map((dir) => join(dir, name))
  .find((p) => existsSync(p))
if (!real) refuse(`${name}: command not found`)

if (!url || !token || !runId) refuse(`HeyBotOS: ${name} was not allowed because this worker has no gate settings.`)

let answer
try {
  const res = await fetch(`${url}/api/gate/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-heybotos-gate': `${runId}:${token}` },
    body: JSON.stringify({ tool: `shim:${name}`, input: { argv } }),
    signal: AbortSignal.timeout(10_000),
  })
  answer = await res.json()
  if (!res.ok) answer = { decision: 'deny', reason: answer.reason }
} catch {
  refuse(`HeyBotOS: the HeyBotOS daemon is not answering, so ${name} is paused. Stop here and report status blocked.`)
}
if (answer.decision !== 'allow') refuse(answer.reason || `HeyBotOS: ${name} was not allowed.`)

const child = spawn(real, argv, { stdio: 'inherit' })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 1)))
child.on('error', (e) => refuse(`${name}: ${e.message}`))
