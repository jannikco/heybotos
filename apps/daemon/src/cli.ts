// Small helper for the terminal: `heybotos open | url | status | install | uninstall | logs` (in a
// checkout: `pnpm heybotos …`). The Mac app calls `ensure` every time it opens.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHome, workerPath } from './home.ts'

const home = openHome()
const base = `http://127.0.0.1:${home.config.port}`
const cmd = process.argv[2] ?? 'status'
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const LABEL = 'com.heybotos.daemon'
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const logFile = join(home.state, 'daemon.log')
const domain = `gui/${userInfo().uid}`

async function api(path: string): Promise<Response | null> {
  try {
    return await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${home.secret}` } })
  } catch {
    return null
  }
}

async function running(): Promise<boolean> {
  return (await api('/api/me'))?.ok === true
}

function loginUrl(): string | null {
  const p = join(home.state, 'login-url')
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inside the Mac app the command is `heybotos`; in a checkout it goes through pnpm. */
const inApp = process.versions.electron !== undefined
const SELF = inApp ? 'heybotos' : 'pnpm heybotos'
const mainFile = join(repo, 'apps', 'daemon', 'src', 'main.ts')
/** What this copy of HeyBotOS was built from; the Mac app carries one, a checkout does not. */
const build = existsSync(join(repo, 'BUILD')) ? readFileSync(join(repo, 'BUILD'), 'utf8').trim() : null

/** PATH as the owner's own terminal has it, so the CLIs are found wherever they were installed. */
function loginPath(): string[] {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    return (/__PATH__(.*)__PATH__/s.exec(out)?.[1] ?? '').split(':')
  } catch {
    return []
  }
}

function plistText(): string {
  // launchd starts programs with an almost empty PATH; the CLIs and node are found through this one.
  const path = [...new Set([...loginPath(), ...workerPath().split(':')].filter((d) => d && !d.includes('/node_modules/.bin')))].join(':')
  const env: Record<string, string> = { PATH: path, HOME: homedir(), LANG: process.env.LANG ?? 'en_US.UTF-8' }
  // The Mac app is its own Node: started with this set, it runs the service instead of opening a window.
  if (inApp) env.ELECTRON_RUN_AS_NODE = '1'
  if (process.env.HEYBOTOS_HOME) env.HEYBOTOS_HOME = process.env.HEYBOTOS_HOME
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(mainFile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`
}

/** What a start-up entry runs, read back from its file: enough to tell whether it is this copy. */
function programOf(text: string): string {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? ''
  return `${[...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).join(' ')}${text.includes('ELECTRON_RUN_AS_NODE') ? ' (app)' : ''}`
}

async function up(tries = 60): Promise<boolean> {
  for (let i = 0; i < tries && !(await running()); i++) await new Promise((r) => setTimeout(r, 250))
  return running()
}

function load(): void {
  mkdirSync(dirname(plist), { recursive: true })
  writeFileSync(plist, plistText())
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' })
  } catch {
    /* was not loaded */
  }
  execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' })
}

/**
 * Make sure the background service is this copy of HeyBotOS and is running: set it up when it is
 * missing or points somewhere else, start it when it is down, restart it when it still runs an
 * older build. Safe to call every time the app opens. Returns what it did.
 */
async function ensure(): Promise<'started' | 'restarted' | 'running'> {
  if (process.platform !== 'darwin') throw new Error('The background service is set up for macOS only.')
  if (!inApp && Number(process.versions.node.split('.')[0]) < 24) throw new Error(`HeyBotOS needs Node 24 or newer; this is ${process.versions.node}.`)
  if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error(inApp ? 'This copy of HeyBotOS is incomplete: the dashboard is missing. Install it again.' : 'Build the dashboard first: pnpm build')
  const mine = existsSync(plist) && programOf(readFileSync(plist, 'utf8')) === programOf(plistText())
  if (!mine) {
    if (!existsSync(plist) && (await running())) throw new Error(`HeyBotOS is already running, started by hand. Stop it first (Ctrl-C where it runs), then try again.`)
    load()
    if (!(await up())) throw new Error(`The service was set up but HeyBotOS did not come up. See ${logFile}`)
    return 'started'
  }
  if (!(await running())) {
    try {
      execFileSync('/bin/launchctl', ['kickstart', `${domain}/${LABEL}`], { stdio: 'ignore' })
    } catch {
      load()
    }
    if (!(await up())) throw new Error(`HeyBotOS did not come up. See ${logFile}`)
    return 'started'
  }
  // After an update the files are new but the service still runs what it loaded before.
  const me = (await (await api('/api/me'))?.json().catch(() => null)) as { build?: string | null } | null
  if (build && me && me.build !== build) {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 600))
    if (!(await up())) throw new Error(`HeyBotOS did not come back up after the update. See ${logFile}`)
    return 'restarted'
  }
  return 'running'
}

/** Keep HeyBotOS running in the background: started at login, restarted if it crashes. */
async function install(): Promise<void> {
  const did = await ensure()
  console.log(`HeyBotOS ${did === 'running' ? 'already runs' : 'now runs'} in the background and starts when you log in.\n  Open it        ${SELF} open\n  Its log        ${logFile}\n  Remove it      ${SELF} uninstall`)
}

function uninstall(): void {
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' })
  } catch {
    /* was not loaded */
  }
  rmSync(plist, { force: true })
  console.log('The background service is removed. Workers that were running keep going until they finish; your data in ~/heybotos is untouched.')
}

try {
  if (cmd === 'install') await install()
  else if (cmd === 'ensure') console.log(JSON.stringify({ ok: true, did: await ensure(), base }))
  else if (cmd === 'uninstall') uninstall()
  else if (cmd === 'logs') console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n') : 'No log yet.')
  else if (!(await running())) {
    console.error(inApp ? 'HeyBotOS is not running. Open the HeyBotOS app, or run "heybotos install".' : 'HeyBotOS is not running. Start it with "pnpm start", or keep it running in the background with "pnpm heybotos install".')
    process.exit(1)
  } else if (cmd === 'open' || cmd === 'url') {
    const url = loginUrl()
    if (!url) throw new Error('No sign-in link found. Restart HeyBotOS.')
    if (cmd === 'url') console.log(url)
    else execFile('/usr/bin/open', [url], () => console.log('Opened the dashboard in your browser.'))
  } else if (cmd === 'status') {
    const runs = ((await (await api('/api/runs'))!.json()) as { runs: Array<{ status: string; role: string | null }> }).runs.filter((r) => r.role !== 'manager')
    const live = runs.filter((r) => ['starting', 'running', 'stopping'].includes(r.status)).length
    const queued = runs.filter((r) => r.status === 'queued').length
    console.log(`HeyBotOS is running at ${base}${existsSync(plist) ? ' (background service)' : ''}. ${live} working, ${queued} waiting to start.`)
  } else {
    console.error(`Usage: ${SELF} open | url | status | install | uninstall | logs`)
    process.exit(1)
  }
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
