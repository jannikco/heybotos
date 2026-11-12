#!/usr/bin/env node
// Stand-in for an agent CLI in tests: replays a recorded JSONL fixture so no test spends
// subscription usage. FAKE_MODE picks a failure to act out.
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
// The health check asks the CLI about itself; answer like a signed-in subscription install.
if (argv[0] === '--version') {
  console.log('0.0.0 (fake)')
  process.exit(0)
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'demo' }))
  process.exit(0)
}
if (argv[0] === 'mcp' && argv[1] === 'list') {
  // What Grok prints for its configured connectors.
  console.log('  shopsystem: https://shop.example/mcp\n  messages: uvx messages-server')
  process.exit(process.env.FAKE_MCP_LIST_FAILS ? 1 : 0)
}
if (argv[0] === 'models') {
  console.log('default')
  process.exit(0)
}
if (argv[0] === 'login' && argv[1] === 'status') {
  console.log('Logged in using ChatGPT')
  process.exit(0)
}

const mode = process.env.FAKE_MODE ?? 'ok'
const delay = Number(process.env.FAKE_DELAY_MS ?? 0)
// Like the real CLI, speak with the session id we were started with rather than the recorded one.
const given = argv[argv.indexOf('--session-id') + 1] ?? argv[argv.indexOf('--resume') + 1]
const wantsId = argv.includes('--session-id') || argv.includes('--resume')
const lines = readFileSync(process.env.FAKE_FIXTURE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => (wantsId ? l.replace(/"session_id":"[^"]*"/g, `"session_id":"${given}"`) : l))
const half = Math.floor(lines.length / 2)

if (process.env.FAKE_ENV_OUT) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(process.env))
if (process.env.FAKE_ARGS_OUT) writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)))

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
await new Promise((r) => process.stdin.on('end', r))
if (process.env.FAKE_STDIN_OUT) writeFileSync(process.env.FAKE_STDIN_OUT, stdin)

if (mode === 'ignore-term') {
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const write = (s) => new Promise((r) => process.stdout.write(s, r))
const forever = () => new Promise(() => setInterval(() => {}, 1000))
const isResult = (line) => {
  try {
    return JSON.parse(line).type === 'result'
  } catch {
    return false
  }
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (mode === 'noresult' && isResult(line)) break
  if (mode === 'crash' && i === half) {
    process.stderr.write('fake: something broke\n')
    process.exit(1)
  }
  if ((mode === 'hang' || mode === 'ignore-term') && i === half) await forever()
  if (mode === 'partial' && i === 3) {
    await write(line.slice(0, 25))
    await sleep(Number(process.env.FAKE_PARTIAL_MS ?? 300))
    await write(`${line.slice(25)}\n`)
    continue
  }
  await write(`${line}\n`)
  if (delay) await sleep(delay)
}
if (mode === 'linger') await forever()
