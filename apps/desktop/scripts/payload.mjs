// What the three build scripts (make-app for macOS, make-linux, make-win) share: getting Electron for
// a system, and filling an app's resources folder with HeyBotOS itself.
//
// Under <resources>/app goes this folder's window code; under <resources>/heybotos the service (its
// TypeScript source, which the app's own runtime runs as it is), the built dashboard, the prompts
// and the gate scripts, laid out as in the repository so the service finds them the same way.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
export const repo = join(desktop, '..', '..')
const require = createRequire(import.meta.url)
const electronDir = dirname(require.resolve('electron/package.json'))
const electronVersion = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version

/** Unpack a zip with what the system this runs on has. */
function unzip(zip, into) {
  mkdirSync(into, { recursive: true })
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-x', '-k', zip, into])
  else if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', into])
  else execFileSync('unzip', ['-q', '-o', zip, '-d', into])
}

/**
 * The folder Electron is unpacked in, for the wanted system and processor: the one already
 * installed when it matches this computer, otherwise a download kept under dist/.
 */
export async function electronDist(platform, arch) {
  if (platform === process.platform && arch === process.arch) {
    const dist = join(electronDir, 'dist')
    if (!existsSync(dist)) throw new Error('Electron is not downloaded yet: run "node node_modules/electron/install.js" in apps/desktop.')
    return dist
  }
  const cache = join(desktop, 'dist', `electron-${electronVersion}-${platform === 'darwin' ? '' : `${platform}-`}${arch}`)
  if (existsSync(cache) && readdirSync(cache).length) return cache
  const { downloadArtifact } = createRequire(join(electronDir, 'package.json'))('@electron/get')
  unzip(await downloadArtifact({ version: electronVersion, platform, arch, artifactName: 'electron' }), cache)
  return cache
}

/** Download a file once into dist/tools and check it is the one that was expected. */
export async function tool(url, sha256) {
  const dir = join(desktop, 'dist', 'tools')
  const file = join(dir, `${sha256.slice(0, 12)}-${url.split('/').pop()}`)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (got !== sha256) {
    rmSync(file, { force: true })
    throw new Error(`${url} is not the file that was expected (its checksum is ${got}).`)
  }
  return file
}

/**
 * Put HeyBotOS into an app's resources folder. `program` is where the app's own program is, seen
 * from <resources>/heybotos: the `heybotos` command for the terminal starts it from there.
 */
export function fillResources(resources, { arch, program }) {
  const { version, stage } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error('Build the dashboard first: pnpm build')
  // The service may only ever use the shared types as types: nothing of that package is shipped.
  for (const f of readdirSync(join(repo, 'apps', 'daemon', 'src'), { recursive: true })) {
    if (!String(f).endsWith('.ts')) continue
    const src = readFileSync(join(repo, 'apps', 'daemon', 'src', String(f)), 'utf8')
    if (/^import (?!type )[^\n]*from '@heybotos\/protocol'/m.test(src)) throw new Error(`apps/daemon/src/${f} imports a value from @heybotos/protocol; the app ships without that package. Use "import type".`)
  }
  rmSync(join(resources, 'default_app.asar'), { force: true })

  // ── the window ──
  const appDir = join(resources, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'heybotos', productName: 'HeyBotOS', version, type: 'module', main: 'main.mjs' }, null, 2))
  for (const f of ['main.mjs', 'preload.cjs']) cpSync(join(desktop, f), join(appDir, f))
  cpSync(join(desktop, 'assets'), join(appDir, 'assets'), { recursive: true })

  // ── the service, the dashboard and what they read ──
  const inside = join(resources, 'heybotos')
  const copy = (...parts) => cpSync(join(repo, ...parts), join(inside, ...parts), { recursive: true })
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'package.json'), JSON.stringify({ name: 'heybotos', version, ...(stage ? { stage } : {}), type: 'module', private: true }, null, 2))
  copy('prompts')
  copy('apps', 'daemon', 'src')
  copy('apps', 'daemon', 'hooks')
  copy('apps', 'web', 'dist')
  writeFileSync(join(inside, 'apps', 'daemon', 'package.json'), JSON.stringify({ name: '@heybotos/daemon', version, type: 'module', private: true }, null, 2))
  // The service's two libraries, as real folders (the workspace keeps them as links into a store).
  for (const dep of Object.keys(JSON.parse(readFileSync(join(repo, 'apps', 'daemon', 'package.json'), 'utf8')).dependencies ?? {})) {
    const dir = realpathSync(join(repo, 'apps', 'daemon', 'node_modules', dep))
    cpSync(dir, join(inside, 'apps', 'daemon', 'node_modules', dep), { recursive: true, dereference: true, filter: (src) => !/[\\/]node_modules/.test(src.slice(dir.length)) })
  }
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(inside, f))
  // What this copy was built from: after an update, the app tells an old running service from a new one by it.
  let commit = ''
  try {
    commit = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    /* not a git checkout */
  }
  writeFileSync(join(inside, 'BUILD'), `${version} ${arch} ${commit} ${new Date().toISOString()}\n`)

  // `heybotos` for the terminal: the app's own program, told to act as Node and run the command-line tool.
  mkdirSync(join(inside, 'bin'), { recursive: true })
  writeFileSync(
    join(inside, 'bin', 'heybotos'),
    `#!/bin/sh
# HeyBotOS from the terminal: heybotos open | url | status | logs | install | uninstall
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
ELECTRON_RUN_AS_NODE=1 exec "$here/${program.replace(/\\/g, '/')}" "$here/apps/daemon/src/cli.ts" "$@"
`,
  )
  chmodSync(join(inside, 'bin', 'heybotos'), 0o755)
  if (program.endsWith('.exe')) {
    writeFileSync(join(inside, 'bin', 'heybotos.cmd'), `@echo off\r\nrem HeyBotOS from the terminal: heybotos open | url | status | logs | install | uninstall\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\${program.replace(/\//g, '\\')}" "%~dp0..\\apps\\daemon\\src\\cli.ts" %*\r\n`)
  }
  return { version, stage, inside }
}
