// What differs between macOS, Linux and Windows, kept in one place: where programs are found and
// how they are started, how a worker and everything it started is stopped, and the small things the
// service asks the system for (a notification, staying awake, opening a link).
import { execFile, execFileSync, spawn, type ChildProcess, type ExecFileOptions, type ExecFileSyncOptions, type SpawnOptions } from 'node:child_process'
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'

export const WIN = process.platform === 'win32'
export const MAC = process.platform === 'darwin'
export const LINUX = process.platform === 'linux'

/** The platform in a word, for messages: "this Mac", "this computer". */
export const THIS_COMPUTER = MAC ? 'this Mac' : 'this computer'

// ── finding programs ──

/** Folders the command-line tools are usually installed in, for when PATH does not have them. */
export function usualBinDirs(): string[] {
  const home = homedir()
  const own = [join(home, '.local', 'bin'), join(home, '.grok', 'bin')]
  if (WIN) {
    const e = process.env
    const maybe = [e.APPDATA && join(e.APPDATA, 'npm'), e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'pnpm'), e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), e.ProgramFiles && join(e.ProgramFiles, 'nodejs'), e.ProgramFiles && join(e.ProgramFiles, 'Git', 'cmd')]
    return [...own, ...maybe.filter((d): d is string => Boolean(d))]
  }
  const system = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return MAC ? [...own, '/opt/homebrew/bin', ...system] : [...own, join(home, '.npm-global', 'bin'), '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...system]
}

/** The endings Windows tries for a program named without one, in the order HeyBotOS wants them. */
const WIN_ENDINGS = ['.exe', '.cmd', '.bat', '']

/** Find a program by bare name in the folders of `path`. A path to a file is returned if the file is there. */
export function findProgram(bin: string, path: string): string | null {
  const names = WIN && !extname(bin) ? WIN_ENDINGS.map((e) => bin + e) : [bin]
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (isAbsolute(bin) || bin.includes('/') || (WIN && bin.includes('\\'))) return names.find(isFile) ?? null
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const n of names) if (isFile(join(dir, n))) return join(dir, n)
  }
  return null
}

/** PATH as the owner's own terminal has it, so the tools are found wherever they were installed. */
export function loginPath(): string[] {
  if (WIN) return (process.env.PATH ?? '').split(delimiter)
  try {
    const shell = process.env.SHELL || userShell()
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
    return (/__PATH__(.*)__PATH__/s.exec(out)?.[1] ?? '').split(':')
  } catch {
    return []
  }
}

/** The shell the owner's account uses. */
export function userShell(): string {
  if (WIN) return process.env.ComSpec || 'cmd.exe'
  if (MAC) return '/bin/zsh'
  try {
    const shell = userInfo().shell
    if (shell && existsSync(shell) && !/(nologin|false)$/.test(shell)) return shell
  } catch {
    /* no account entry */
  }
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
}

// ── starting programs ──

export interface Launch {
  file: string
  args: string[]
  /** Extra settings the program needs in its environment to start this way. */
  env: Record<string, string>
  /** Windows only: the arguments are already quoted for the command interpreter. */
  verbatim: boolean
}

const asIs = (file: string, args: string[]): Launch => ({ file, args, env: {}, verbatim: false })

/** This program acting as Node: the app's own runtime inside the desktop app, plain Node otherwise. */
export function asNode(script: string, args: string[] = []): Launch {
  return { file: process.execPath, args: [script, ...args], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}, verbatim: false }
}

function firstLine(file: string): string {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(256)
    const n = readSync(fd, buf, 0, 256, 0)
    closeSync(fd)
    return buf.subarray(0, n).toString('utf8').split(/\r?\n/)[0] ?? ''
  } catch {
    return ''
  }
}

/** A Unix shell on Windows: the one Git for Windows brings. (The bash in System32 starts WSL, which is something else.) */
export function windowsSh(): string | null {
  const e = process.env
  for (const root of [e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs')]) {
    if (!root) continue
    for (const rel of [join('Git', 'bin', 'sh.exe'), join('Git', 'usr', 'bin', 'sh.exe')]) if (existsSync(join(root, rel))) return join(root, rel)
  }
  for (const dir of (e.PATH ?? '').split(delimiter)) {
    if (!dir || /\\system32\\?$/i.test(dir)) continue
    if (existsSync(join(dir, 'sh.exe'))) return join(dir, 'sh.exe')
  }
  return null
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g
/** One argument, quoted so that cmd.exe and then the program's own parser both see it whole. */
function cmdArg(arg: string, twice: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`.replace(CMD_META, '^$1')
  return twice ? a.replace(CMD_META, '^$1') : a
}

/**
 * How to start a program so that it works the same everywhere. On macOS and Linux a file is run as
 * it is. Windows cannot start a script directly: a command file (.cmd, how npm installs tools) is
 * followed to the script it runs, or handed to the command interpreter with every argument quoted;
 * a script with a "#!" line is given to Node or to Git's shell.
 */
export function launch(file: string, args: string[]): Launch {
  if (!WIN) return asIs(file, args)
  const ext = extname(file).toLowerCase()
  if (ext === '.exe' || ext === '.com') return asIs(file, args)
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return asNode(file, args)
  if (ext === '.cmd' || ext === '.bat') {
    // An npm command file ends in: "%_prog%" "%dp0%\node_modules\pkg\bin\tool.js" %*
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      /* fall through to the command interpreter */
    }
    const script = /"%~?dp0%?\\?([^"]+\.[cm]?js)"\s+%\*/i.exec(text)?.[1]
    if (script && existsSync(join(dirname(file), script))) {
      const beside = join(dirname(file), 'node.exe')
      const node = existsSync(beside) ? beside : findProgram('node', process.env.PATH ?? '')
      if (node) return asIs(node, [join(dirname(file), script), ...args])
    }
    const line = [file.replace(CMD_META, '^$1'), ...args.map((a) => cmdArg(a, true))].join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], env: {}, verbatim: true }
  }
  const first = firstLine(file)
  if (first.startsWith('#!')) {
    if (/\bnode\b/.test(first)) return asNode(file, args)
    const sh = windowsSh()
    if (sh) return asIs(sh, [file, ...args])
  }
  return asIs(file, args)
}

/** Where a program named without a folder is, looked up the way the system would for this environment. */
function placed(file: string, env: NodeJS.ProcessEnv | undefined): string {
  if (!WIN || isAbsolute(file) || file.includes('/') || file.includes('\\')) return file
  return findProgram(file, (env ?? process.env).PATH ?? (env ?? process.env).Path ?? '') ?? file
}

/** Start a program that keeps running. Like spawn(), but a script or command file starts on Windows too. */
export function startProgram(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const l = launch(placed(file, options.env), args)
  return spawn(l.file, l.args, { ...options, env: { ...(options.env ?? process.env), ...l.env }, windowsHide: true, windowsVerbatimArguments: l.verbatim })
}

/** Run a program and hand its output to `done`. Like execFile(). */
export function runProgram(file: string, args: string[], options: ExecFileOptions, done: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  const l = launch(placed(file, options.env), args)
  return execFile(l.file, l.args, { ...options, encoding: 'utf8', env: { ...(options.env ?? process.env), ...l.env }, windowsHide: true, windowsVerbatimArguments: l.verbatim }, (err, stdout, stderr) => done(err, String(stdout), String(stderr)))
}

/** Run a program and wait for its output. Like execFileSync() with text output. */
export function runProgramSync(file: string, args: string[], options: ExecFileSyncOptions = {}): string {
  const l = launch(placed(file, options.env), args)
  // execFileSync passes this on to the system like spawn does; its types just do not list it.
  const verbatim = { windowsVerbatimArguments: l.verbatim } as ExecFileSyncOptions
  return String(execFileSync(l.file, l.args, { ...options, ...verbatim, encoding: 'utf8', env: { ...(options.env ?? process.env), ...l.env }, windowsHide: true }) ?? '')
}

/** git, wherever it is installed. */
export const GIT = WIN ? 'git' : existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git'

/**
 * Write a command called `name` into `dir` that runs one of HeyBotOS's own scripts, with `first` as
 * its first arguments and whatever it is called with after them. On macOS and Linux that is one
 * shell script. On Windows it is three files side by side, the way npm installs a tool, so the name
 * works from Git's shell, from the command interpreter and from PowerShell alike. Returns the path
 * to call it by.
 */
export function writeCommand(dir: string, name: string, script: string, first: string[] = []): string {
  const l = asNode(script, first)
  const path = join(dir, name)
  const sh = (s: string) => `'${(WIN ? s.replace(/\\/g, '/') : s).replace(/'/g, `'\\''`)}'`
  const set = Object.entries(l.env)
  writeFileSync(path, `#!/bin/sh\n${set.map(([k, v]) => `${k}=${v} `).join('')}exec ${[l.file, ...l.args].map(sh).join(' ')} "$@"\n`, { mode: 0o755 })
  if (!WIN) {
    chmodSync(path, 0o755)
    return path
  }
  const dq = (s: string) => `"${s}"`
  writeFileSync(`${path}.cmd`, `@echo off\r\n${set.map(([k, v]) => `set "${k}=${v}"\r\n`).join('')}${[l.file, ...l.args].map(dq).join(' ')} %*\r\n`)
  const call = `& ${[l.file, ...l.args].map(dq).join(' ')} @args`
  writeFileSync(`${path}.ps1`, `${set.map(([k, v]) => `$env:${k} = "${v}"\r\n`).join('')}if ($MyInvocation.ExpectingInput) { $input | ${call} } else { ${call} }\r\nexit $LASTEXITCODE\r\n`)
  return path
}

/**
 * A line of text that runs one of HeyBotOS's own scripts, for places that take a command as text (a
 * hook in a CLI's settings). On Windows a line cannot set what the app needs in its environment to
 * act as Node, so it is a command written into `dir` instead.
 */
export function scriptLine(script: string, dir: string, name: string): string {
  if (WIN) {
    const path = writeCommand(dir, name, script).replace(/\\/g, '/')
    return /\s/.test(path) ? `"${path}"` : path
  }
  const l = asNode(script)
  const words = [l.file, ...l.args].map((w) => JSON.stringify(w)).join(' ')
  return [...Object.entries(l.env).map(([k, v]) => `${k}=${v}`), words].join(' ')
}

// ── processes ──

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Something that tells this process from a later one that got the same number: its start time, or
 * on Windows the name of its program (asking Windows for a start time takes too long to do for
 * every worker).
 */
export function processMark(pid: number): string | null {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      return /^"([^"]+)"/.exec(out.trim())?.[1] ?? null
    }
    return execFileSync(existsSync('/bin/ps') ? '/bin/ps' : 'ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** Signal a worker and everything it started. Windows has no polite signal for that: there, both mean stop now. */
export function signalTree(pid: number, sig: NodeJS.Signals): void {
  if (WIN) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      /* already gone */
    }
  }
}

// ── small things asked of the system ──

const short = (s: string, n = 220) => s.replace(/\s+/g, ' ').slice(0, n)

/** A notification on the owner's screen. Quiet where the system offers no simple way; the desktop app shows its own. */
export function systemNotify(title: string, body: string): void {
  if (MAC) {
    const quote = (s: string) => `"${short(s).replace(/[\\"]/g, '\\$&')}"`
    execFile('/usr/bin/osascript', ['-e', `display notification ${quote(body)} with title "HeyBotOS" subtitle ${quote(title)}`], { timeout: 5000 }, () => {})
  } else if (LINUX) {
    execFile('notify-send', ['--app-name=HeyBotOS', '--', short(title), short(body)], { timeout: 5000 }, () => {})
  }
}

/** Keep the computer from going to sleep for as long as this process lives. Null where that cannot be asked for. */
export function holdAwake(): ChildProcess | null {
  try {
    if (MAC) return spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    if (LINUX) return spawn('systemd-inhibit', ['--what=idle:sleep', '--who=HeyBotOS', '--why=Workers are running', 'tail', `--pid=${process.pid}`, '-f', '/dev/null'], { stdio: 'ignore' })
  } catch {
    /* not available here */
  }
  return null
}

/** Open a link in the owner's browser. */
export function openLink(url: string, done: (ok: boolean) => void = () => {}): void {
  const [file, args] = MAC ? ['/usr/bin/open', [url]] : WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  execFile(file as string, args as string[], { windowsHide: true }, (err) => done(!err))
}
