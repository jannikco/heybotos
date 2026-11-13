// Tries a whole update for real: an installed HeyBotOS is offered a newer version, fetches it, checks
// it, replaces itself and comes back up as the new version. Used by the GitHub workflows on Linux and
// Windows, where nobody looks at a screen.
//
//   node scripts/smoke-update.mjs --app <folder of the installed app> --package <file with the newer version> --version <its version>
//
// The newer version is a second build made with "--as <version>" (see make-linux.mjs, make-win.mjs).
// This script plays the project: it publishes that file with a list of updates signed by a key made
// for the occasion, from a web server on this computer, and tells the installed app (through its
// settings) to look there and trust that key. Everything else is the real thing. On Linux, run it
// under xvfb-run. Do not run it on a computer where HeyBotOS is in use: it sets up the background
// service for the app it is given.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { flag } from './payload.mjs'

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const app = flag('--app')
const pack = flag('--package')
const newer = flag('--version')
if (!app || !pack || !newer) throw new Error('Needs --app <installed app>, --package <file with the newer version> and --version <its version>.')
const program = MAC ? join(app, 'Contents', 'MacOS', 'HeyBotOS') : join(app, WIN ? 'HeyBotOS.exe' : 'heybotos')
const resources = () => (MAC ? join(app, 'Contents', 'Resources') : join(app, 'resources'))
const start = MAC || WIN ? program : join(app, 'heybotos-desktop')
const PORT = 4752
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── the stand-in project: a key, a signed list, a web server ──
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const sha256 = createHash('sha256').update(readFileSync(pack)).digest('hex')
const server = createServer((req, res) => {
  if (req.url === '/latest.json') return void res.end(manifest)
  if (req.url === '/latest.json.sig') return void res.end(sign(null, Buffer.from(manifest), privateKey).toString('base64'))
  if (req.url === `/${encodeURIComponent(basename(pack))}`) return void createReadStream(pack).pipe(res)
  res.statusCode = 404
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const site = `http://127.0.0.1:${server.address().port}`
const manifest = JSON.stringify({
  version: newer,
  notes: '- A version made to try the update with.',
  published: new Date().toISOString(),
  page: `${site}/`,
  files: { [`${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`]: { url: `${site}/${encodeURIComponent(basename(pack))}`, sha256, size: statSync(pack).size } },
})

// ── the installed app, with its own data folder, told where to look ──
const home = mkdtempSync(join(tmpdir(), 'heybotos-update-'))
mkdirSync(join(home, 'config'), { recursive: true })
writeFileSync(join(home, 'config', 'heybotos.json'), JSON.stringify({ port: PORT, projectRoots: [], updates: { auto: false, url: `${site}/latest.json`, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } }))
const env = { ...process.env, HEYBOTOS_HOME: home }
const call = async (path, method = 'GET') => {
  try {
    const secret = readFileSync(join(home, 'state', 'secret'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(method === 'GET' ? 3000 : 120_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
const until = async (what, seconds, test) => {
  for (let i = 0; i < seconds; i++) {
    const got = await test()
    if (got) return got
    await sleep(1000)
  }
  throw new Error(`${what} did not happen within ${seconds} seconds.`)
}

console.log(`Starting ${start}\n  data folder ${home}\n  updates published at ${site}`)
let output = ''
const first = spawn(start, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
first.stdout.on('data', (d) => (output += d))
first.stderr.on('data', (d) => (output += d))

let problem = ''
try {
  const before = await until('The service answering', 120, () => call('/api/me'))
  console.log(`Installed: version ${before.version}, build "${before.build}"`)
  if (before.version === newer) throw new Error(`The installed app already is version ${newer}.`)

  const found = await call('/api/update/check', 'POST')
  if (!found?.latest) throw new Error(`The app did not find the newer version: ${found?.problem ?? 'no answer'}`)
  if (found.how !== 'app') throw new Error(`The app says it cannot replace itself (${found.how}): ${found.hint ?? ''}`)
  console.log(`The app found version ${found.latest.version}.`)

  // A second start with this flag asks the running app to update, as its "Update and restart" button does.
  spawn(start, ['--install-update'], { env, stdio: 'ignore', detached: !WIN }).unref()
  const after = await until(`Version ${newer} answering`, 240, async () => {
    const me = await call('/api/me')
    return me?.version === newer ? me : null
  })
  console.log(`Updated: version ${after.version}, build "${after.build}"`)
  const built = readFileSync(join(resources(), 'heybotos', 'BUILD'), 'utf8').trim()
  if (after.build !== built) throw new Error(`The service that answers ("${after.build}") is not the app that is installed now ("${built}").`)
  const log = join(home, 'state', 'updates', 'install.log')
  if (existsSync(log)) console.log(`  ${readFileSync(log, 'utf8').trim().split('\n').join('\n  ')}`)
  // The new app is meant to be open again, not just its service.
  await until('The new app opening', 60, async () => ((await call('/api/update'))?.current === newer && appRuns() ? true : null))
  console.log('The new version is open and its service answers.')
} catch (e) {
  problem = e.message
}

/** Whether a window process of the app (not its service) is running. */
function appRuns() {
  try {
    if (WIN) return execFileSync('tasklist', ['/FI', 'IMAGENAME eq HeyBotOS.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('HeyBotOS.exe')).length > 1
    return appPids().length > 0
  } catch {
    return false
  }
}
/** Linux: the app's processes, found by the program they run, leaving out the service. */
function appPids() {
  const pids = []
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      if (readlinkSync(`/proc/${pid}/exe`).replace(' (deleted)', '') !== program) continue
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('main.ts')) pids.push(Number(pid))
    } catch {
      /* gone, or not ours to read */
    }
  }
  return pids
}

// ── put things back ──
try {
  if (existsSync(program)) console.log(`  ${execFileSync(program, [join(resources(), 'heybotos', 'apps', 'daemon', 'src', 'cli.ts'), 'uninstall'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 }).trim()}`)
} catch (e) {
  problem ||= `"heybotos uninstall" failed after the update: ${e.message}`
}
try {
  if (WIN) execFileSync('taskkill', ['/IM', 'HeyBotOS.exe', '/F'], { stdio: 'ignore' })
  else if (!MAC) for (const pid of appPids()) process.kill(pid, 'SIGTERM')
} catch {
  /* nothing left running */
}
server.close()

if (problem) {
  console.error(`\nFAILED: ${problem}`)
  console.error(`\n── what the app printed ──\n${output.split('\n').slice(-30).join('\n')}`)
  for (const f of [join(home, 'state', 'updates', 'install.log'), join(home, 'state', 'daemon.log')]) if (existsSync(f)) console.error(`\n── ${basename(f)} ──\n${readFileSync(f, 'utf8').split('\n').slice(-30).join('\n')}`)
  process.exit(1)
}
console.log('\nThe update works.')
process.exit(0)
