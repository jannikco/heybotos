// Builds HeyBotOS for Windows, on Windows: the app as a folder, and from it a .zip and an installer.
//
//   node scripts/make-win.mjs [--arch x64|arm64] [--only setup] [--as <version> --out <folder>]
//
// The installer is made with NSIS (makensis): the one installed here, or one this script fetches. Nothing is uploaded, and
// nothing is signed: Windows will say the publisher is unknown the first time the installer runs.
//
// The installer puts the app in the owner's own programs folder, so it asks for no administrator
// rights. The app carries the service, as on the Mac: it starts it, and has Windows start it at
// sign-in, the first time it opens.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktop, electronDist, fillResources, flag, OUT, tool } from './payload.mjs'

if (process.platform !== 'win32') throw new Error('The Windows packages are built on Windows (the GitHub release workflow does it).')
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch is arm64 or x64.')
// Puts the icon and the name into the program file. A fixed release, checked against its checksum.
const RCEDIT = ['https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe', '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a']
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })

// ── the app as a folder ──
const work = join(OUT, `win-${arch}`)
const app = join(work, 'HeyBotOS')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
cpSync(await electronDist('win32', arch), app, { recursive: true })
renameSync(join(app, 'electron.exe'), join(app, 'HeyBotOS.exe'))
const { version } = fillResources(join(app, 'resources'), { arch, program: '../../HeyBotOS.exe' })
const icon = join(desktop, 'build', 'icon.ico')
run(await tool(...RCEDIT), [
  join(app, 'HeyBotOS.exe'),
  '--set-icon', icon,
  '--set-file-version', version,
  '--set-product-version', version,
  '--set-version-string', 'ProductName', 'HeyBotOS',
  '--set-version-string', 'FileDescription', 'HeyBotOS',
  '--set-version-string', 'CompanyName', 'HeyBotOS contributors',
  '--set-version-string', 'LegalCopyright', 'HeyBotOS contributors. MIT licence.',
  '--set-version-string', 'OriginalFilename', 'HeyBotOS.exe',
])
const made = []

// ── .zip ──
if (flag('--only') !== 'setup') {
  const out = join(OUT, `HeyBotOS-${version}-win-${arch}.zip`)
  rmSync(out, { force: true })
  // The tar that comes with Windows writes zip files too.
  run('tar', ['-a', '-c', '-f', out, '-C', work, 'HeyBotOS'])
  made.push(out)
}

// ── installer ──
// NSIS, which makes the installer: the one on this computer if there is one, otherwise a fixed
// release, fetched once and checked against its checksum.
const NSIS = ['https://downloads.sourceforge.net/project/nsis/NSIS%203/3.10/nsis-3.10.zip', 'fcdce3229717a2a148e7cda0ab5bdb667f39d8fb33ede1da8dabc336bd5ad110']
const works = (bin) => {
  try {
    execFileSync(bin, ['/VERSION'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
let makensis = ['makensis', join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS', 'makensis.exe')].find(works)
if (!makensis && !process.argv.includes('--no-installer')) {
  try {
    const zip = await tool(...NSIS)
    const into = join(desktop, 'dist', 'tools', 'nsis')
    if (!existsSync(join(into, 'nsis-3.10', 'makensis.exe'))) {
      mkdirSync(into, { recursive: true })
      run('tar', ['-xf', zip, '-C', into])
    }
    if (works(join(into, 'nsis-3.10', 'makensis.exe'))) makensis = join(into, 'nsis-3.10', 'makensis.exe')
  } catch (e) {
    console.log(`NSIS could not be fetched: ${e.message}`)
  }
}
if (makensis) {
  const out = join(OUT, `HeyBotOS-${version}-win-${arch}-setup.exe`)
  rmSync(out, { force: true })
  const kb = Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -Recurse -File '${app}' | Measure-Object -Sum Length).Sum`], { encoding: 'utf8' }).trim()) / 1024)
  const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HeyBotOS'
  const nsi = join(work, 'installer.nsi')
  writeFileSync(
    nsi,
    `Unicode true
!include "MUI2.nsh"

Name "HeyBotOS"
OutFile "${out}"
InstallDir "$LOCALAPPDATA\\Programs\\HeyBotOS"
InstallDirRegKey HKCU "Software\\HeyBotOS" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true
VIProductVersion "${version}.0"
VIAddVersionKey "ProductName" "HeyBotOS"
VIAddVersionKey "FileDescription" "HeyBotOS installer"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "ProductVersion" "${version}"
VIAddVersionKey "CompanyName" "HeyBotOS contributors"
VIAddVersionKey "LegalCopyright" "HeyBotOS contributors. MIT licence."

!define MUI_ICON "${icon}"
!define MUI_UNICON "${icon}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\\HeyBotOS.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open HeyBotOS"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; A running copy holds its files open. This stops the window and the background service; workers
; are other programs and keep going, and the service picks them up when it starts again.
!macro StopHeyBotOS
  nsExec::Exec 'taskkill /IM HeyBotOS.exe /F'
  Pop $0
  Sleep 1200
!macroend

Section "HeyBotOS"
  !insertmacro StopHeyBotOS
  ; Only what an earlier version put here is cleared away, never the folder as a whole.
  RMDir /r "$INSTDIR\\resources"
  RMDir /r "$INSTDIR\\locales"
  SetOutPath "$INSTDIR"
  File /r "${app}\\*.*"
  WriteUninstaller "$INSTDIR\\Uninstall HeyBotOS.exe"
  CreateShortcut "$SMPROGRAMS\\HeyBotOS.lnk" "$INSTDIR\\HeyBotOS.exe"
  WriteRegStr HKCU "Software\\HeyBotOS" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "HeyBotOS"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "HeyBotOS contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\\HeyBotOS.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\\Uninstall HeyBotOS.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/jannikco/heybotos"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${kb}
SectionEnd

Section "Uninstall"
  !insertmacro StopHeyBotOS
  DeleteRegValue HKCU "${RUN_KEY}" "HeyBotOS"
  Delete "$SMPROGRAMS\\HeyBotOS.lnk"
  ; The app's own files and folders, by name: whatever else is in the folder stays. The owner's
  ; data (the heybotos folder in their home folder) is not touched.
  RMDir /r "$INSTDIR\\resources"
  RMDir /r "$INSTDIR\\locales"
  Delete "$INSTDIR\\*.exe"
  Delete "$INSTDIR\\*.dll"
  Delete "$INSTDIR\\*.pak"
  Delete "$INSTDIR\\*.bin"
  Delete "$INSTDIR\\*.dat"
  Delete "$INSTDIR\\*.json"
  Delete "$INSTDIR\\*.html"
  Delete "$INSTDIR\\LICENSE*"
  Delete "$INSTDIR\\version"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\\HeyBotOS"
SectionEnd
`,
  )
  run(makensis, ['/V2', nsi])
  made.push(out)
} else console.log('No NSIS here (makensis), and it could not be fetched: the installer is skipped.')

console.log(`\nBuilt for Windows ${arch}:\n${made.map((f) => `  ${f}  (${(statSync(f).size / 1024 / 1024).toFixed(0)} MB)`).join('\n')}\n  ${app}\\  (the app as a folder)`)
