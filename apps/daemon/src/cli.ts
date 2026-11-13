// Small helper for the terminal: `heybotos open | url | status | install | uninstall | logs` (in a
// checkout: `pnpm heybotos …`). The desktop app calls `ensure` every time it opens.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHome, workerPath } from './home.ts'
import { alive, LINUX, loginPath, MAC, openLink, WIN } from './platform.ts'

const home = openHome()
const base = `http://127.0.0.1:${home.config.port}`
const cmd = process.argv[2] ?? 'status'
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const logFile = join(home.state, 'daemon.log')
const pidFile = join(home.state, 'daemon.pid')

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

/** Inside the desktop app the command is `heybotos`; in a checkout it goes through pnpm. */
const inApp = process.versions.electron !== undefined
const SELF = inApp ? 'heybotos' : 'pnpm heybotos'
const mainFile = join(repo, 'apps', 'daemon', 'src', 'main.ts')
/** What this copy of HeyBotOS was built from; the desktop app carries one, a checkout does not. */
const build = existsSync(join(repo, 'BUILD')) ? readFileSync(join(repo, 'BUILD'), 'utf8').trim() : null

/** What the service is started with in its environment. A service gets an almost empty PATH; the CLIs and node are found through this one. */
function serviceEnv(): Record<string, string> {
  const path = [...new Set([...loginPath(), ...workerPath().split(WIN ? ';' : ':')].filter((d) => d && !d.includes('node_modules/.bin') && !d.includes('node_modules\\.bin')))].join(WIN ? ';' : ':')
  const env: Record<string, string> = { PATH: path, HOME: homedir(), LANG: process.env.LANG ?? 'en_US.UTF-8' }
  // The desktop app is its own Node: started with this set, it runs the service instead of opening a window.
  if (inApp) env.ELECTRON_RUN_AS_NODE = '1'
  if (process.env.HEYBOTOS_HOME) env.HEYBOTOS_HOME = process.env.HEYBOTOS_HOME
  return env
}

const quiet = (file: string, args: string[]) => execFileSync(file, args, { stdio: 'ignore', windowsHide: true })
function tryQuiet(file: string, args: string[]): boolean {
  try {
    quiet(file, args)
    return true
  } catch {
    return false
  }
}

/** Start the service by hand, cut loose from this process, writing to its log. Used where no service manager takes care of it. */
function startLoose(): void {
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'a')
  spawn(process.execPath, [mainFile], { cwd: repo, env: { ...process.env, ...serviceEnv() }, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
}

/** Stop a service that was started by hand. Its workers keep running. */
function stopLoose(): void {
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0
  if (!pid || !alive(pid)) return
  if (WIN) tryQuiet('taskkill', ['/PID', String(pid), '/F'])
  else process.kill(pid, 'SIGTERM')
}

/**
 * The part of the system that keeps HeyBotOS running in the background: started at login and, where
 * the system can, started again if it stops.
 */
interface Service {
  /** There is a start-up entry (of any copy). */
  exists(): boolean
  /** The start-up entry is there and runs this copy. */
  mine(): boolean
  /** Write the start-up entry and start (or start again) from it. */
  load(): void
  /** Start it when the entry is there but nothing runs. */
  start(): void
  /** Stop what runs and start this copy. */
  restart(): void
  /** Take the entry away and stop the service. */
  remove(): void
}

// ── macOS: a launchd agent ──

const LABEL = 'com.heybotos.daemon'

function launchd(): Service {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const domain = `gui/${userInfo().uid}`
  const text = () => `<?xml version="1.0" encoding="UTF-8"?>
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
${Object.entries(serviceEnv())
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
  /** What a start-up entry runs, read back from its file: enough to tell whether it is this copy. */
  const programOf = (t: string) => {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(t)?.[1] ?? ''
    return `${[...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).join(' ')}${t.includes('ELECTRON_RUN_AS_NODE') ? ' (app)' : ''}`
  }
  const load = () => {
    mkdirSync(dirname(plist), { recursive: true })
    writeFileSync(plist, text())
    tryQuiet('/bin/launchctl', ['bootout', `${domain}/${LABEL}`])
    quiet('/bin/launchctl', ['bootstrap', domain, plist])
  }
  return {
    exists: () => existsSync(plist),
    mine: () => existsSync(plist) && programOf(readFileSync(plist, 'utf8')) === programOf(text()),
    load,
    start: () => quiet('/bin/launchctl', ['kickstart', `${domain}/${LABEL}`]),
    restart: () => quiet('/bin/launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]),
    remove: () => {
      tryQuiet('/bin/launchctl', ['bootout', `${domain}/${LABEL}`])
      rmSync(plist, { force: true })
    },
  }
}

// ── Linux: a systemd user service, or where there is none an autostart entry ──

function linux(): Service {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const unit = join(config, 'systemd', 'user', 'heybotos.service')
  const autostart = join(config, 'autostart', 'heybotos.desktop')
  const ctl = (...args: string[]) => quiet('systemctl', ['--user', ...args])
  const systemd = tryQuiet('systemctl', ['--user', 'show-environment'])
  // In a unit file a percent sign starts a placeholder and a dollar sign a variable.
  const lit = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
  // Settings that take a single path take it as it is, to the end of the line; quotes would become part of it.
  const bare = (v: string) => v.replace(/%/g, '%%')
  const unitText = () => `[Unit]
Description=HeyBotOS: a manager agent and its team of workers
After=network.target
# If the app is removed while this entry stays behind, there is nothing to start and nothing to retry.
ConditionPathExists=${bare(process.execPath)}

[Service]
ExecStart=${lit(process.execPath)} ${lit(mainFile)}
WorkingDirectory=${bare(repo)}
${Object.entries(serviceEnv())
  .map(([k, v]) => `Environment=${lit(`${k}=${v}`)}`)
  .join('\n')}
Restart=on-failure
RestartSec=15
# Stopping the service stops only the service: workers keep running and are picked up at the next start.
KillMode=process
StandardOutput=append:${bare(logFile)}
StandardError=append:${bare(logFile)}

[Install]
WantedBy=default.target
`
  const entryText = () => `[Desktop Entry]
Type=Application
Name=HeyBotOS service
Comment=Keeps the HeyBotOS manager and workers running
Exec=/bin/sh -c ${JSON.stringify(`${Object.entries(serviceEnv()).filter(([k]) => k !== 'HOME').map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(' ')} exec '${process.execPath}' '${mainFile}' >> '${logFile}' 2>&1`)}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`
  const programOf = (t: string) => `${/^ExecStart=(.*)$/m.exec(t)?.[1] ?? /exec ('[^']*' '[^']*')/.exec(t)?.[1] ?? ''}${t.includes('ELECTRON_RUN_AS_NODE') ? ' (app)' : ''}`
  const file = systemd ? unit : autostart
  const text = systemd ? unitText : entryText
  return {
    exists: () => existsSync(unit) || existsSync(autostart),
    mine: () => existsSync(file) && programOf(readFileSync(file, 'utf8')) === programOf(text()),
    load: () => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text())
      if (systemd) {
        rmSync(autostart, { force: true })
        ctl('daemon-reload')
        ctl('enable', 'heybotos.service')
        ctl('restart', 'heybotos.service')
      } else {
        stopLoose()
        startLoose()
      }
    },
    start: () => (systemd ? ctl('start', 'heybotos.service') : startLoose()),
    restart: () => {
      if (systemd) return ctl('restart', 'heybotos.service')
      stopLoose()
      startLoose()
    },
    remove: () => {
      if (existsSync(unit) && systemd) tryQuiet('systemctl', ['--user', 'disable', '--now', 'heybotos.service'])
      else stopLoose()
      rmSync(unit, { force: true })
      rmSync(autostart, { force: true })
      if (systemd) tryQuiet('systemctl', ['--user', 'daemon-reload'])
    },
  }
}

// ── Windows: started at sign-in from the owner's Run key ──

function windows(): Service {
  if (!inApp) throw new Error('On Windows the background service comes with the HeyBotOS app. In a checkout, run "pnpm start" in a terminal and leave it open.')
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  // The app, asked to start its service and leave again without showing a window.
  const line = `"${process.execPath}" --service`
  const current = () => {
    try {
      const out = execFileSync('reg', ['query', KEY, '/v', 'HeyBotOS'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return /HeyBotOS\s+REG_SZ\s+(.*)/.exec(out)?.[1]?.trim() ?? null
    } catch {
      return null
    }
  }
  const again = () => {
    stopLoose()
    startLoose()
  }
  return {
    exists: () => current() !== null,
    mine: () => current() === line,
    load: () => {
      quiet('reg', ['add', KEY, '/v', 'HeyBotOS', '/t', 'REG_SZ', '/d', line, '/f'])
      again()
    },
    start: startLoose,
    restart: again,
    remove: () => {
      tryQuiet('reg', ['delete', KEY, '/v', 'HeyBotOS', '/f'])
      stopLoose()
    },
  }
}

function service(): Service {
  if (MAC) return launchd()
  if (LINUX) return linux()
  if (WIN) return windows()
  throw new Error(`HeyBotOS has no background service for this system (${process.platform}). Run "pnpm start" in a terminal instead.`)
}

async function up(tries = 60): Promise<boolean> {
  for (let i = 0; i < tries && !(await running()); i++) await new Promise((r) => setTimeout(r, 250))
  return running()
}

/**
 * Make sure the background service is this copy of HeyBotOS and is running: set it up when it is
 * missing or points somewhere else, start it when it is down, restart it when it still runs an
 * older build. Safe to call every time the app opens. Returns what it did.
 */
async function ensure(): Promise<'started' | 'restarted' | 'running'> {
  if (!inApp && Number(process.versions.node.split('.')[0]) < 24) throw new Error(`HeyBotOS needs Node 24 or newer; this is ${process.versions.node}.`)
  if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error(inApp ? 'This copy of HeyBotOS is incomplete: the dashboard is missing. Install it again.' : 'Build the dashboard first: pnpm build')
  const svc = service()
  if (!svc.mine()) {
    if (!svc.exists() && (await running())) throw new Error(`HeyBotOS is already running, started by hand. Stop it first (Ctrl-C where it runs), then try again.`)
    svc.load()
    if (!(await up())) throw new Error(`The service was set up but HeyBotOS did not come up. See ${logFile}`)
    return 'started'
  }
  if (!(await running())) {
    try {
      svc.start()
    } catch {
      svc.load()
    }
    if (!(await up())) throw new Error(`HeyBotOS did not come up. See ${logFile}`)
    return 'started'
  }
  // After an update the files are new but the service still runs what it loaded before.
  const me = (await (await api('/api/me'))?.json().catch(() => null)) as { build?: string | null } | null
  if (build && me && me.build !== build) {
    svc.restart()
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
  service().remove()
  console.log(`The background service is removed. Workers that were running keep going until they finish; your data in ${home.root} is untouched.`)
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
    else openLink(url, (ok) => console.log(ok ? 'Opened the dashboard in your browser.' : `Could not open a browser. Open this link yourself: ${url}`))
  } else if (cmd === 'status') {
    const runs = ((await (await api('/api/runs'))!.json()) as { runs: Array<{ status: string; role: string | null }> }).runs.filter((r) => r.role !== 'manager')
    const live = runs.filter((r) => ['starting', 'running', 'stopping'].includes(r.status)).length
    const queued = runs.filter((r) => r.status === 'queued').length
    let kept = false
    try {
      kept = service().exists()
    } catch {
      /* no background service on this system */
    }
    console.log(`HeyBotOS is running at ${base}${kept ? ' (background service)' : ''}. ${live} working, ${queued} waiting to start.`)
  } else {
    console.error(`Usage: ${SELF} open | url | status | install | uninstall | logs`)
    process.exit(1)
  }
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
