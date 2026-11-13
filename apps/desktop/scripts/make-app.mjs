// Builds dist/<arch>/HeyBotOS.app: Electron's own application bundle with HeyBotOS inside it.
//
// The app carries everything: this folder's window code, and under Resources/heybotos the service
// (its TypeScript source, which the app's own runtime runs as it is), the built dashboard, the
// prompts and the gate scripts, laid out as in the repository so the service finds them the same
// way. No Node has to be installed on the Mac it runs on.
//
// Usage: node scripts/make-app.mjs [--arch arm64|x64]
// Signing: ad hoc unless HEYBOTOS_SIGN_IDENTITY names a Developer ID (see scripts/release.mjs).
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..', '..')
const require = createRequire(import.meta.url)
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch is arm64 or x64.')

const { version, stage } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const electronDir = dirname(require.resolve('electron/package.json'))
const electronVersion = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version

/** Electron for the wanted kind of Mac: the one already installed, or a download of the other. */
async function electronApp() {
  if (arch === process.arch) {
    const app = join(electronDir, 'dist', 'Electron.app')
    if (!existsSync(app)) throw new Error('Electron is not downloaded yet: run "node node_modules/electron/install.js" in apps/desktop.')
    return app
  }
  const cache = join(desktop, 'dist', `electron-${electronVersion}-${arch}`)
  const app = join(cache, 'Electron.app')
  if (existsSync(app)) return app
  const { downloadArtifact } = createRequire(join(electronDir, 'package.json'))('@electron/get')
  const zip = await downloadArtifact({ version: electronVersion, platform: 'darwin', arch, artifactName: 'electron' })
  mkdirSync(cache, { recursive: true })
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, cache])
  return app
}

if (!existsSync(join(repo, 'apps', 'web', 'dist', 'index.html'))) throw new Error('Build the dashboard first: pnpm build')
// The service may only ever use the shared types as types: nothing of that package is shipped.
for (const f of readdirSync(join(repo, 'apps', 'daemon', 'src'), { recursive: true })) {
  if (!String(f).endsWith('.ts')) continue
  const src = readFileSync(join(repo, 'apps', 'daemon', 'src', String(f)), 'utf8')
  if (/^import (?!type )[^\n]*from '@heybotos\/protocol'/m.test(src)) throw new Error(`apps/daemon/src/${f} imports a value from @heybotos/protocol; the app ships without that package. Use "import type".`)
}

const out = join(desktop, 'dist', arch, 'HeyBotOS.app')
rmSync(join(desktop, 'dist', arch), { recursive: true, force: true })
mkdirSync(join(desktop, 'dist', arch), { recursive: true })
// ditto keeps the symlinks and metadata inside the frameworks intact; a plain copy breaks them.
execFileSync('/usr/bin/ditto', [await electronApp(), out])

const resources = join(out, 'Contents', 'Resources')
rmSync(join(resources, 'default_app.asar'), { force: true })

// ── the window ──
const appDir = join(resources, 'app')
mkdirSync(appDir, { recursive: true })
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'heybotos', productName: 'HeyBotOS', version, type: 'module', main: 'main.mjs' }, null, 2))
for (const f of ['main.mjs', 'preload.cjs']) cpSync(join(desktop, f), join(appDir, f))
cpSync(join(desktop, 'assets'), join(appDir, 'assets'), { recursive: true })
cpSync(join(desktop, 'build', 'icon.icns'), join(resources, 'HeyBotOS.icns'))

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
  cpSync(dir, join(inside, 'apps', 'daemon', 'node_modules', dep), { recursive: true, dereference: true, filter: (src) => !src.slice(dir.length).includes('/node_modules') })
}
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(inside, f))
// What this copy was built from: after an update, the app tells an old running service from a new one by it.
let commit = ''
try {
  commit = execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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
ELECTRON_RUN_AS_NODE=1 exec "$here/../../MacOS/HeyBotOS" "$here/apps/daemon/src/cli.ts" "$@"
`,
)
chmodSync(join(inside, 'bin', 'heybotos'), 0o755)

// ── the bundle's own facts ──
const plist = join(out, 'Contents', 'Info.plist')
const set = (key, value, type = 'string') => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist])
  }
}
set('CFBundleName', 'HeyBotOS')
set('CFBundleDisplayName', 'HeyBotOS')
set('CFBundleIdentifier', 'com.heybotos.app')
set('CFBundleIconFile', 'HeyBotOS.icns')
set('CFBundleShortVersionString', version)
set('CFBundleVersion', version)
set('LSApplicationCategoryType', 'public.app-category.developer-tools')
set('LSMinimumSystemVersion', '12.0')
set('NSHumanReadableCopyright', '"HeyBotOS contributors. MIT licence."')
// The executable keeps Electron's name inside the bundle; give it ours so Activity Monitor says HeyBotOS.
renameSync(join(out, 'Contents', 'MacOS', 'Electron'), join(out, 'Contents', 'MacOS', 'HeyBotOS'))
set('CFBundleExecutable', 'HeyBotOS')

// Electron's bundle is dated 1980, and macOS remembers an app's icon by the bundle's date: without a
// date of its own, an update would keep showing the icon of the copy it replaced.
const builtAt = new Date()
utimesSync(out, builtAt, builtAt)

// ── signing ──
const identity = process.env.HEYBOTOS_SIGN_IDENTITY
if (identity) {
  // A Developer ID signature with the hardened runtime, which is what Apple notarises.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--options', 'runtime', '--timestamp', '--entitlements', join(desktop, 'build', 'entitlements.plist'), '--sign', identity, out], { stdio: 'inherit' })
} else {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', out], { stdio: 'inherit' })
}
console.log(`Built ${out} (${arch}, ${identity ? 'signed with a Developer ID' : 'signed ad hoc'})`)
