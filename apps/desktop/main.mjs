// HeyBotOS for macOS. A native shell around the local HeyBotOS service: its own window, a menu-bar item
// that shows who is working, a global shortcut to ask the manager, native notifications and a Dock
// badge for what is waiting. The installed app carries the service and sets it up as a background
// item of its own, so it keeps running without this window.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
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
  await new Promise((done) => execFile('/bin/launchctl', ['kickstart', `gui/${userInfo().uid}/com.heybotos.daemon`], () => done(null)))
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300))
    ;({ base, secret } = service())
    if (await alive()) return true
  }
  serviceProblem = 'From the source code, the service is set up once with: pnpm build && pnpm heybotos install'
  return false
}

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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
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
  // Closing the window keeps the app (and its menu-bar item) alive, as Mac apps do.
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
// Settings → Project folders: the Mac's own chooser, folders only. Only the path goes back.
ipcMain.handle('pick-folder', async (e) => {
  const owner = BrowserWindow.fromWebContents(e.sender)
  const options = { title: 'Choose a folder that holds projects', buttonLabel: 'Add folder', properties: ['openDirectory', 'createDirectory'] }
  const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return res.canceled ? null : (res.filePaths[0] ?? null)
})

// ── what is going on: one stream from the service feeds the menu bar, the Dock and notifications ──

const world = { runs: new Map(), tasks: new Map(), approvals: new Map(), name: 'Manager', connected: false }
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
  tray.setTitle(w.length ? ` ${w.length}` : '', { fontType: 'monospacedDigit' })
  tray.setToolTip(world.connected ? `HeyBotOS: ${w.length} working${waiting ? `, ${waiting} waiting for you` : ''}` : 'HeyBotOS: not connected to the service')
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open HeyBotOS', click: () => go('/') },
      { label: `Ask ${world.name}…`, accelerator: SHORTCUT, click: toggleQuick },
      { type: 'separator' },
      ...(waiting ? [{ label: `${waiting} waiting for you`, click: () => go('/inbox') }, { type: 'separator' }] : []),
      { label: w.length ? 'Working now' : 'Nobody is working', enabled: false },
      ...w.slice(0, 8).map((r) => ({ label: `${clip(r.title, 38)}${r.activity ? `  –  ${clip(r.activity, 34)}` : ''}`, click: () => go(`/agents/${r.id}`) })),
      ...(w.length > 8 ? [{ label: `and ${w.length - 8} more`, click: () => go('/agents') }] : []),
      { type: 'separator' },
      { label: 'Quit HeyBotOS', accelerator: 'Command+Q', click: () => app.quit() },
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'HeyBotOS', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Command+,', click: () => go('/settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'File', submenu: [{ label: 'New Task…', accelerator: 'Command+N', click: () => (go(win?.webContents.getURL().replace(base, '') || '/'), win?.webContents.send('command', 'new-task')) }, { label: 'Ask…', accelerator: SHORTCUT, click: toggleQuick }, { type: 'separator' }, { role: 'close' }] },
      { role: 'editMenu' },
      { label: 'Go', submenu: [...SECTIONS.map(([label, path, key]) => ({ label, accelerator: `Command+${key}`, click: () => go(path) })), { type: 'separator' }, { label: 'Find or Run…', accelerator: 'Command+K', click: () => (win?.show(), win?.webContents.send('command', 'palette')) }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  )
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => go('/'))
  app.on('before-quit', () => (quitting = true))
  app.on('activate', () => go('/'))
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => globalShortcut.unregisterAll())

  // Not awaited at the top level: Electron only becomes ready once this module has finished loading.
  void app.whenReady().then(() => {
    app.setName('HeyBotOS')
    appMenu()
    createWindow()
    tray = new Tray(nativeImage.createFromPath(join(here, 'assets', 'trayTemplate.png')))
    tray.on('click', () => tray.popUpContextMenu())
    refresh()
    globalShortcut.register(SHORTCUT, toggleQuick)
    void listen()
  })
}
