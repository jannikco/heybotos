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
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { desktop, electronDist, fillResources, repo } from './payload.mjs'

const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch is arm64 or x64.')

const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

const out = join(desktop, 'dist', arch, 'HeyBotOS.app')
rmSync(join(desktop, 'dist', arch), { recursive: true, force: true })
mkdirSync(join(desktop, 'dist', arch), { recursive: true })
// ditto keeps the symlinks and metadata inside the frameworks intact; a plain copy breaks them.
execFileSync('/usr/bin/ditto', [join(await electronDist('darwin', arch), 'Electron.app'), out])

const resources = join(out, 'Contents', 'Resources')
fillResources(resources, { arch, program: '../../MacOS/HeyBotOS' })
cpSync(join(desktop, 'build', 'icon.icns'), join(resources, 'HeyBotOS.icns'))

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
