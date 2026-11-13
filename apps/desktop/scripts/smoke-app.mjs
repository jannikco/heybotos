// Starts a built HeyBotOS app the way a person would and checks that it works: the window opens, the
// app sets up its background service, the service answers, and the terminal command can remove it
// again. Everything happens in a throwaway data folder. Used by the GitHub workflows on Linux and
// Windows, where nobody looks at a screen.
//
//   node scripts/smoke-app.mjs --app <folder of the built app> [--start <program> [arguments…]]
//
// --start is what to run to open the app (default: the app's own program in --app). On Linux, run
// this under xvfb-run. Writes a picture of the window to dist/smoke-<system>.png.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktop } from './payload.mjs'

const args = process.argv.slice(2)
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const app = value('--app')
if (!app) throw new Error('--app <folder of the built app> is needed.')
const program = MAC ? join(app, 'Contents', 'MacOS', 'HeyBotOS') : join(app, WIN ? 'HeyBotOS.exe' : 'heybotos')
const resources = MAC ? join(app, 'Contents', 'Resources') : join(app, 'resources')
const start = args.includes('--start') ? args.slice(args.indexOf('--start') + 1) : [MAC || WIN ? program : join(app, 'heybotos-desktop')]

const home = mkdtempSync(join(tmpdir(), 'heybotos-smoke-'))
// A port of its own, so a HeyBotOS that is really in use on this computer is left alone.
const PORT = 4751
mkdirSync(join(home, 'config'), { recursive: true })
writeFileSync(join(home, 'config', 'heybotos.json'), JSON.stringify({ port: PORT, projectRoots: [] }))
const shot = join(desktop, 'dist', `smoke-${process.platform}-${process.arch}.png`)
rmSync(shot, { force: true })
const env = { ...process.env, HEYBOTOS_HOME: home, HEYBOTOS_DESKTOP_SHOT: shot }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cli = (...words) => execFileSync(program, [join(resources, 'heybotos', 'apps', 'daemon', 'src', 'cli.ts'), ...words], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 }).trim()

console.log(`Starting ${start.join(' ')}\n  data folder ${home}`)
let output = ''
const child = spawn(start[0], start.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))
let exited = null
child.on('exit', (code) => (exited = code))

async function me() {
  try {
    const secret = readFileSync(join(home, 'state', 'secret'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

let problem = ''
try {
  let answer = null
  for (let i = 0; i < 120 && !answer && exited === null; i++) {
    await sleep(1000)
    answer = await me()
  }
  if (!answer) throw new Error(exited !== null ? `The app ended by itself (code ${exited}) before its service answered.` : 'The service did not answer within two minutes.')
  console.log(`The service answers: version ${answer.version}${answer.stage ? ` ${answer.stage}` : ''}, build "${answer.build}"`)
  const built = readFileSync(join(resources, 'heybotos', 'BUILD'), 'utf8').trim()
  if (answer.build !== built) throw new Error(`The service that answers is another build ("${answer.build}") than this app ("${built}").`)
  for (let i = 0; i < 40 && !existsSync(shot); i++) await sleep(1000)
  if (!existsSync(shot)) throw new Error('The window never showed the dashboard (no picture of it was saved).')
  console.log(`The window shows the dashboard: ${shot}`)
  console.log(`  ${cli('status')}`)
} catch (e) {
  problem = e.message
}

// Close the window; the service is meant to outlive it.
if (exited === null) {
  if (WIN) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  } else child.kill('SIGTERM')
  await sleep(3000)
}
if (!problem) {
  if (!(await me())) problem = 'The service stopped when the window was closed; it is meant to keep running.'
  else console.log('The service keeps running with the window closed.')
}
try {
  console.log(`  ${cli('uninstall')}`)
  await sleep(2500)
  if (await me()) problem ||= 'The service still answers after "heybotos uninstall".'
  else if (!problem) console.log('The service is gone after "heybotos uninstall".')
} catch (e) {
  problem ||= `"heybotos uninstall" failed: ${e.message}`
}

if (problem) {
  console.error(`\nFAILED: ${problem}`)
  console.error(`\n── what the app printed ──\n${output.split('\n').slice(-40).join('\n')}`)
  const log = join(home, 'state', 'daemon.log')
  if (existsSync(log)) console.error(`\n── the service's log ──\n${readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`)
  process.exit(1)
}
rmSync(home, { recursive: true, force: true })
console.log('\nThe app works.')
process.exit(0)
