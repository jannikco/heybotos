// HeyBotOS on the desktop (macOS, Linux, Windows). A native shell around the local HeyBotOS service:
// its own window, an item in the menu bar or notification area that shows who is working, a global
// shortcut to ask the manager, native notifications and (on the Mac) a Dock badge for what is
// waiting. The installed app carries the service and sets it up as a background item of its own, so
// it keeps running without this window.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MAC = process.platform === 'darwin'
const WIN = process.platform === 'win32'
const HOME = process.env.HEYBOTOS_HOME || join(homedir(), 'heybotos')
const SHORTCUT = 'Alt+Shift+Space'
const PARTITION = 'persist:heybotos'

function service() {
  let port = 4747
  try {
    port = JSON.parse(readFileSync(join(HOME, 'config', 'heybotos.json'), 'utf8')).port ?? 4747
  } catch {
    /* default port */
  }
  let secret = ''
  try {
    secret = readFileSync(join(HOME, 'state', 'secret'), 'utf8').trim()
  } catch {
    /* no service has ever run */
  }
  return { base: `http://127.0.0.1:${port}`, secret }
}

let { base, secret } = service()
const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })

async function alive() {
  try {
    return (await api('/api/me', { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

// A packaged app carries the service under Resources/heybotos; from the source code there is none inside.
const INSIDE = join(process.resourcesPath ?? '', 'heybotos')
const CARRIES_SERVICE = app.isPackaged && existsSync(join(INSIDE, 'apps', 'daemon', 'src', 'cli.ts'))
let serviceProblem = ''

/** Run the command-line tool that came with this app, on the app's own runtime. */
function cli(args, timeout = 60_000) {
  return new Promise((done) => {
    execFile(process.execPath, [join(INSIDE, 'apps', 'daemon', 'src', 'cli.ts'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout }, (err, stdout, stderr) =>
      done({ ok: !err, out: String(stdout).trim(), problem: String(stderr).trim() || err?.message || '' }),
    )
  })
}

/**
 * The service runs in the background, on its own, so workers and routines keep going when this
 * window is closed. The app sets it up the first time, starts it when it is down, and restarts it
 * after an update. From the source code, the service is whatever "pnpm heybotos install" set up.
 */
async function ensureService() {
  if (CARRIES_SERVICE) {
    const r = await cli(['ensure'])
    serviceProblem = r.ok ? '' : r.problem
    ;({ base, secret } = service())
    return r.ok && (await alive())
  }
  if (await alive()) return true
  if (MAC) await new Promise((done) => execFile('/bin/launchctl', ['kickstart', `gui/${userInfo().uid}/com.heybotos.daemon`], () => done(null)))
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300))
    ;({ base, secret } = service())
    if (await alive()) return true
  }
  serviceProblem = 'From the source code, the service is set up once with: pnpm build && pnpm heybotos install'
  return false
}

// ── updates ─────────────────────────────────────────────────────────────────────────────────
// The service finds a newer version, fetches it and checks that it is the one the project published.
// Replacing the app is done here, by a small script that outlives this process: it waits for the app
// to close, puts the new one in its place and opens it again. The new app then restarts the
// service, as after any update.

/** The installed app as a whole: the bundle on the Mac, its folder elsewhere. */
const APP_PATH = MAC ? join(process.resourcesPath ?? '', '..', '..') : dirname(process.execPath)
let installing = false

const INSTALLERS = {
  // $1 the app, $2 the zip, $3 the process to wait for
  darwin: `#!/bin/sh
app="$1"; zip="$2"; pid="$3"; work="$(dirname "$zip")/work"
exec >>"$(dirname "$zip")/install.log" 2>&1
echo "$(date): installing $zip over $app"
back() { echo "$1"; [ -n "$HEYBOTOS_UPDATE_NO_OPEN" ] || /usr/bin/open "$app"; exit 1; }
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
rm -rf "$work"; mkdir -p "$work" || back "could not make a work folder"
/usr/bin/ditto -x -k "$zip" "$work" || back "could not unpack the new version"
[ -x "$work/HeyBotOS.app/Contents/MacOS/HeyBotOS" ] || back "the download is not the HeyBotOS app"
rm -rf "$app.old"
mv "$app" "$app.old" || back "could not move the old version aside"
if mv "$work/HeyBotOS.app" "$app"; then rm -rf "$app.old"; else mv "$app.old" "$app"; back "could not put the new version in place"; fi
rm -rf "$work" "$zip"
echo "$(date): done"
[ -n "$HEYBOTOS_UPDATE_NO_OPEN" ] || /usr/bin/open "$app"
`,
  // $1 the app's folder, $2 the .tar.gz, $3 the process to wait for
  linux: `#!/bin/sh
app="$1"; tgz="$2"; pid="$3"; work="$(dirname "$tgz")/work"
exec >>"$(dirname "$tgz")/install.log" 2>&1
echo "$(date): installing $tgz over $app"
again() { [ -n "$HEYBOTOS_UPDATE_NO_OPEN" ] || (nohup "$app/heybotos-desktop" >/dev/null 2>&1 &); }
back() { echo "$1"; again; exit 1; }
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
rm -rf "$work"; mkdir -p "$work" || back "could not make a work folder"
tar -xzf "$tgz" -C "$work" || back "could not unpack the new version"
[ -x "$work/HeyBotOS/heybotos" ] || back "the download is not the HeyBotOS app"
rm -rf "$app.old"
mv "$app" "$app.old" || back "could not move the old version aside"
if mv "$work/HeyBotOS" "$app"; then rm -rf "$app.old"; else mv "$app.old" "$app"; back "could not put the new version in place"; fi
rm -rf "$work" "$tgz"
echo "$(date): done"
again
`,
  // %1 the installer, %2 the app's program, %3 the process to wait for. The installer itself stops
  // whatever of HeyBotOS still runs, and installs where the app already is.
  win32: `@echo off\r
setlocal\r
set n=0\r
:wait\r
tasklist /FI "PID eq %~3" 2>nul | find "%~3" >nul\r
if errorlevel 1 goto go\r
set /a n+=1\r
if %n% GEQ 30 goto go\r
ping -n 2 127.0.0.1 >nul\r
goto wait\r
:go\r
echo %date% %time%: installing %~1 >> "%~dp0install.log"\r
start "" /wait "%~1" /S\r
echo %date% %time%: done >> "%~dp0install.log"\r
if not defined HEYBOTOS_UPDATE_NO_OPEN start "" "%~2"\r
`,
}

/** Start the script that replaces this app with the fetched file once this process has ended. */
function startInstaller(file) {
  const text = INSTALLERS[process.platform]
  if (!text) throw new Error('HeyBotOS cannot update itself on this system.')
  const script = join(dirname(file), WIN ? 'install-update.cmd' : 'install-update.sh')
  writeFileSync(script, text, { mode: 0o755 })
  const args = WIN ? ['/d', '/c', script, file, process.execPath, String(process.pid)] : [script, APP_PATH, file, String(process.pid)]
  // Cut loose from this process, so closing the app does not take the script with it.
  spawn(WIN ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: dirname(file) }).unref()
}

/**
 * Fetch the newer version if that has not been done, hand it to the installer script and close.
 * Answers with what went wrong when it could not get that far.
 */
async function installUpdate() {
  if (installing) return { ok: true }
  installing = true
  try {
    if (!CARRIES_SERVICE) throw new Error('This copy runs from the source code. Update it with "git pull".')
    if (!(await ensureService())) throw new Error('The HeyBotOS service is not running, so the new version cannot be fetched.')
    let s = await (await api('/api/update')).json()
    if (!s.latest) s = await (await api('/api/update/check', { method: 'POST' })).json()
    if (!s.latest) throw new Error(s.problem || 'This is the newest version.')
    if (s.how !== 'app') throw new Error(s.hint || 'This copy of HeyBotOS cannot replace itself.')
    if (s.status !== 'ready') s = await (await api('/api/update/download', { method: 'POST' })).json()
    if (s.status !== 'ready' || !s.file) throw new Error(s.problem || 'The new version could not be fetched.')
    startInstaller(s.file)
    console.log(`[heybotos] installing ${s.latest.version}`)
    quitting = true
    setTimeout(() => app.quit(), 400)
    return { ok: true }
  } catch (e) {
    installing = false
    console.error('[heybotos] update not installed:', e?.message ?? e)
    return { ok: false, problem: String(e?.message ?? e) }
  }
}
ipcMain.handle('install-update', () => installUpdate())

// ── windows ─────────────────────────────────────────────────────────────────────────────────

let win = null
let quick = null
let tray = null
let quitting = false
const boundsFile = () => join(app.getPath('userData'), 'window.json')

function savedBounds() {
  try {
    return JSON.parse(readFileSync(boundsFile(), 'utf8'))
  } catch {
    return { width: 1480, height: 940 }
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
/** Shown in the window when the service cannot be reached: what went wrong, and a way to try again. */
const downPage = () =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a102a;color:#eef0fb;font:15px -apple-system,system-ui;-webkit-app-region:drag"><div style="max-width:32rem;padding:2rem;-webkit-app-region:no-drag"><h1 style="font-size:1.6rem;letter-spacing:-.02em;margin:0 0 .7rem">HeyBotOS could not start its service</h1><p style="color:#a5acc9;line-height:1.55;margin:0 0 1.1rem">The service is the part that runs your agents in the background. It did not come up.</p>${serviceProblem ? `<pre style="background:rgba(150,170,255,.08);border-radius:.7rem;padding:.85rem 1rem;margin:0 0 1.3rem;font:12px ui-monospace,Menlo;white-space:pre-wrap;color:#eef0fb">${esc(serviceProblem)}</pre>` : ''}<button onclick="location.href='heybotos://retry'" style="font:inherit;font-weight:600;background:linear-gradient(100deg,#315dfb,#7a55f6);color:#fff;border:0;border-radius:99px;padding:.6rem 1.25rem;cursor:pointer">Try again</button></div></body>`,
  )}`

async function load(target, path = '/') {
  if (!(await ensureService())) return target.loadURL(downPage())
  try {
    // A fresh single-use sign-in link from the service; the session cookie it sets lasts months,
    // so this is only ever a redirect.
    const { url } = await (await api(`/api/login-link?next=${encodeURIComponent(path)}`)).json()
    await target.loadURL(url)
  } catch (e) {
    console.error('[heybotos] could not load the dashboard:', e?.message ?? e)
    await target.loadURL(downPage())
  }
}

function guard(w) {
  // The window shows HeyBotOS and nothing else. Links to anywhere else open in the browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(base)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('heybotos://retry')) {
      e.preventDefault()
      void load(w)
    } else if (!url.startsWith(base) && !url.startsWith('data:')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a102a',
    // On the Mac the page itself is the title bar, with the window buttons laid over it. Elsewhere the
    // window keeps the system's own frame, with the menu tucked away until Alt is pressed.
    ...(MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true, icon: join(here, 'assets', 'icon.png') }),
    webPreferences: { preload: join(here, 'preload.cjs'), partition: PARTITION, contextIsolation: true, sandbox: true, spellcheck: true },
  })
  guard(win)
  win.once('ready-to-show', () => win.show())
  // For checking the app without looking at the screen: HEYBOTOS_DESKTOP_SHOT=<file> saves what the
  // window itself renders (not the screen) a few seconds after it loads.
  if (process.env.HEYBOTOS_DESKTOP_SHOT) {
    win.webContents.on('did-finish-load', () => {
      console.log('[heybotos] loaded', win.webContents.getURL().slice(0, 60))
      setTimeout(async () => {
        try {
          writeFileSync(process.env.HEYBOTOS_DESKTOP_SHOT, (await win.webContents.capturePage()).toPNG())
          console.log('[heybotos] shot saved')
        } catch (e) {
          console.error('[heybotos] shot failed:', e?.message ?? e)
        }
      }, 3500)
    })
  }
  const remember = () => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(boundsFile(), JSON.stringify(win.getBounds()))
    } catch {
      /* not worth failing over */
    }
  }
  win.on('resized', remember)
  win.on('moved', remember)
  // Closing the window keeps the app (and its menu-bar or notification-area item) alive.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  void load(win)
}

function go(path) {
  if (!win) createWindow()
  win.show()
  win.focus()
  if (win.webContents.getURL().startsWith(base)) win.webContents.send('navigate', path)
  else void load(win, path)
}

function toggleQuick() {
  if (quick?.isVisible()) return quick.hide()
  if (!quick) {
    quick = new BrowserWindow({
      width: 720,
      height: 172,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: true,
      webPreferences: { preload: join(here, 'preload.cjs'), partition: PARTITION, contextIsolation: true, sandbox: true },
    })
    guard(quick)
    quick.on('blur', () => quick?.hide())
    quick.on('closed', () => (quick = null))
    quick.once('ready-to-show', () => quick.show())
    void load(quick, '/quick')
  } else {
    quick.show()
    quick.webContents.send('command', 'focus')
  }
  quick.center()
  const [x] = quick.getPosition()
  quick.setPosition(x, 180)
}

ipcMain.on('quick-done', () => {
  quick?.hide()
  go('/')
})
ipcMain.on('quick-cancel', () => quick?.hide())
// Settings → Project folders: the system's own chooser, folders only. Only the path goes back.
ipcMain.handle('pick-folder', async (e) => {
  const owner = BrowserWindow.fromWebContents(e.sender)
  const options = { title: 'Choose a folder that holds projects', buttonLabel: 'Add folder', properties: ['openDirectory', 'createDirectory'] }
  const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return res.canceled ? null : (res.filePaths[0] ?? null)
})

// ── what is going on: one stream from the service feeds the menu bar, the Dock and notifications ──

const world = { runs: new Map(), tasks: new Map(), approvals: new Map(), name: 'Manager', connected: false, update: null, toldAbout: '' }
const working = () => [...world.runs.values()].filter((r) => r.role !== 'manager' && ['starting', 'running', 'stopping'].includes(r.status))
const waitingForOwner = () => {
  const withRequest = new Set([...world.approvals.values()].map((a) => a.taskId))
  return world.approvals.size + [...world.tasks.values()].filter((t) => (t.status === 'needs_input' || t.status === 'blocked') && !withRequest.has(t.id)).length
}

function notify(title, body, path) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body: body.replace(/\s+/g, ' ').slice(0, 220), silent: false })
  n.on('click', () => go(path))
  n.show()
}

function refresh() {
  const w = working()
  const waiting = waitingForOwner()
  app.dock?.setBadge(waiting ? String(waiting) : '')
  if (!tray) return
  // Only the Mac's menu bar has room for a number beside the icon.
  if (MAC) tray.setTitle(w.length ? ` ${w.length}` : '', { fontType: 'monospacedDigit' })
  tray.setToolTip(world.connected ? `HeyBotOS: ${w.length} working${waiting ? `, ${waiting} waiting for you` : ''}` : 'HeyBotOS: not connected to the service')
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open HeyBotOS', click: () => go('/') },
      { label: `Ask ${world.name}…`, accelerator: SHORTCUT, click: toggleQuick },
      ...(world.update?.latest ? [{ label: `Version ${world.update.latest.version} is available…`, click: () => go('/settings/general') }] : []),
      { type: 'separator' },
      ...(waiting ? [{ label: `${waiting} waiting for you`, click: () => go('/inbox') }, { type: 'separator' }] : []),
      { label: w.length ? 'Working now' : 'Nobody is working', enabled: false },
      ...w.slice(0, 8).map((r) => ({ label: `${clip(r.title, 38)}${r.activity ? `  –  ${clip(r.activity, 34)}` : ''}`, click: () => go(`/agents/${r.id}`) })),
      ...(w.length > 8 ? [{ label: `and ${w.length - 8} more`, click: () => go('/agents') }] : []),
      { type: 'separator' },
      { label: 'Quit HeyBotOS', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]),
  )
}

function onFrame(event, data) {
  if (event === 'hello') {
    world.runs = new Map(data.runs.map((r) => [r.id, r]))
    world.tasks = new Map(data.tasks.map((t) => [t.id, t]))
    world.approvals = new Map(data.approvals.map((a) => [a.id, a]))
  } else if (event === 'run') {
    world.runs.set(data.id, data)
  } else if (event === 'task') {
    const before = world.tasks.get(data.id)?.status
    world.tasks.set(data.id, data)
    if (before !== data.status && data.status === 'needs_input' && ![...world.approvals.values()].some((a) => a.taskId === data.id)) notify(data.title, `Asks: ${data.question ?? ''}`, `/agents/${data.lastRunId ?? data.id}`)
    if (before !== data.status && data.status === 'blocked') notify(data.title, `Blocked: ${data.summary ?? ''}`, `/agents/${data.lastRunId ?? data.id}`)
  } else if (event === 'approval') {
    if (data.status === 'pending') {
      if (!world.approvals.has(data.id)) notify(data.title, `Waiting for your yes or no: ${data.summary}`, '/inbox')
      world.approvals.set(data.id, data)
    } else world.approvals.delete(data.id)
  } else if (event === 'identity') {
    world.name = data.managerName
  } else if (event === 'update') {
    world.update = data
    // Said once per version, not at every check.
    if (data.latest && data.status === 'available' && world.toldAbout !== data.latest.version) {
      world.toldAbout = data.latest.version
      notify('HeyBotOS', `Version ${data.latest.version} is available.`, '/settings/general')
    }
  } else if (event === 'chat') {
    // The answer arrived while you were looking at something else.
    if (data.message?.role === 'manager' && !(win?.isFocused() ?? false)) notify(world.name, data.message.text, '/')
  } else return
  refresh()
}

async function listen() {
  for (;;) {
    try {
      ;({ base, secret } = service())
      world.name = (await (await api('/api/me')).json()).managerName ?? 'Manager'
      world.update = await (await api('/api/update')).json().catch(() => null)
      // "client=desktop" tells the service this app shows notifications, so it does not show its own.
      const res = await api('/api/stream?client=desktop')
      if (!res.ok || !res.body) throw new Error('no stream')
      world.connected = true
      refresh()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          let event = 'message'
          let data = ''
          for (const line of buffer.slice(0, cut).split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          buffer = buffer.slice(cut + 2)
          if (data) {
            try {
              onFrame(event, JSON.parse(data))
            } catch {
              /* a frame we do not understand is skipped */
            }
          }
        }
      }
    } catch {
      /* fall through to the retry */
    }
    world.connected = false
    refresh()
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// ── the app ─────────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  ['Chief of Staff', '/', '1'],
  ['Inbox', '/inbox', '2'],
  ['Agents', '/agents', '3'],
  ['Board', '/board', '4'],
  ['Projects', '/projects', '5'],
  ['Routines', '/routines', '6'],
  ['Usage', '/usage', '7'],
]

function appMenu() {
  const settings = { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => go('/settings') }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // The Mac has a menu of the app's own; elsewhere Settings and Quit live in the File menu.
      ...(MAC ? [{ label: 'HeyBotOS', submenu: [{ role: 'about' }, { type: 'separator' }, settings, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { label: 'File', submenu: [{ label: 'New Task…', accelerator: 'CommandOrControl+N', click: () => (go(win?.webContents.getURL().replace(base, '') || '/'), win?.webContents.send('command', 'new-task')) }, { label: 'Ask…', accelerator: SHORTCUT, click: toggleQuick }, { type: 'separator' }, ...(MAC ? [] : [settings, { type: 'separator' }]), { role: 'close' }, ...(MAC ? [] : [{ label: 'Quit HeyBotOS', accelerator: 'CommandOrControl+Q', click: () => app.quit() }])] },
      { role: 'editMenu' },
      { label: 'Go', submenu: [...SECTIONS.map(([label, path, key]) => ({ label, accelerator: `CommandOrControl+${key}`, click: () => go(path) })), { type: 'separator' }, { label: 'Find or Run…', accelerator: 'CommandOrControl+K', click: () => (win?.show(), win?.webContents.send('command', 'palette')) }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  )
}

// Windows shows a notification only for an app that has said who it is.
if (WIN) app.setAppUserModelId('com.heybotos.app')

if (process.argv.includes('--service')) {
  // Started at sign-in (Windows): bring the background service up and leave again, without a window.
  void app.whenReady().then(async () => {
    if (CARRIES_SERVICE) await cli(['ensure'])
    app.exit(0)
  })
} else if (!app.requestSingleInstanceLock()) app.quit()
else {
  // A second start brings the window forward; started with --install-update, it asks this one to update.
  app.on('second-instance', (_e, argv) => (argv.includes('--install-update') ? void installUpdate() : go('/')))
  app.on('before-quit', () => (quitting = true))
  app.on('activate', () => go('/'))
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => globalShortcut.unregisterAll())

  // Not awaited at the top level: Electron only becomes ready once this module has finished loading.
  void app.whenReady().then(() => {
    app.setName('HeyBotOS')
    appMenu()
    createWindow()
    // The Mac's menu bar takes a one-colour image and tints it; the others show the mark in colour.
    tray = new Tray(nativeImage.createFromPath(join(here, 'assets', MAC ? 'trayTemplate.png' : WIN ? 'tray.png' : 'tray-large.png')))
    if (MAC) tray.on('click', () => tray.popUpContextMenu())
    else tray.on('click', () => go('/'))
    refresh()
    globalShortcut.register(SHORTCUT, toggleQuick)
    void listen()
    if (process.argv.includes('--install-update')) void installUpdate()
  })
}
