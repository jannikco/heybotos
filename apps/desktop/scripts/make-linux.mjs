// Builds HeyBotOS for Linux, on Linux: the app as a folder, and from it a .deb (Debian, Ubuntu, Mint),
// an AppImage (any distribution) and a .tar.gz.
//
//   node scripts/make-linux.mjs [--arch x64|arm64] [--only tar] [--as <version> --out <folder>]
//
// Needs dpkg-deb for the .deb and mksquashfs (squashfs-tools) for the AppImage; a package whose tool
// is missing is skipped with a note. Nothing is uploaded.
//
// The app carries the service, as on the Mac. An AppImage is mounted only while it runs, and the
// service has to outlive it, so the AppImage copies the app to ~/.local/share/heybotos/app the first
// time (and after an update) and runs it from there.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktop, electronDist, fillResources, flag, OUT, tool } from './payload.mjs'

if (process.platform !== 'linux') throw new Error('The Linux packages are built on Linux (the GitHub release workflow does it).')
const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch is arm64 or x64.')
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }[arch]
const APPIMAGE_ARCH = { x64: 'x86_64', arm64: 'aarch64' }[arch]
// The small program at the front of every AppImage, which mounts the rest and starts it. A fixed
// release, checked against its checksum.
const RUNTIME = {
  x64: ['https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64', '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d'],
  arm64: ['https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-aarch64', '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444'],
}[arch]

const has = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const script = (file, text) => {
  writeFileSync(file, text)
  chmodSync(file, 0o755)
}

// ── the app as a folder ──
const work = join(OUT, `linux-${arch}`)
const app = join(work, 'HeyBotOS')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
// cp -a keeps the modes (the sandbox helper) and the links as they are.
run('cp', ['-a', await electronDist('linux', arch), app])
renameSync(join(app, 'electron'), join(app, 'heybotos'))
const { version } = fillResources(join(app, 'resources'), { arch, program: '../../heybotos' })
cpSync(join(desktop, 'build', 'icons', '512.png'), join(app, 'heybotos.png'))
// Whatever this computer's settings for new files are, the packages get the usual ones: nothing writable by others.
run('chmod', ['-R', 'go-w,a+rX', app])

// What the menu entry starts. Chromium's sandbox needs either its helper owned by root with the
// setuid bit (the .deb sets that up) or permission to make user namespaces (Ubuntu 24.04 and later
// keep that from programs that have no AppArmor profile). Without either the window could not
// open at all, so only then is the sandbox left out; the window shows HeyBotOS's own local page and
// nothing from the web.
script(
  join(app, 'heybotos-desktop'),
  `#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
sandbox="$here/chrome-sandbox"
if [ -u "$sandbox" ] && [ "$(stat -c %u "$sandbox" 2>/dev/null)" = 0 ]; then
  exec "$here/heybotos" "$@"
elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ] && unshare -Ur true 2>/dev/null; then
  exec "$here/heybotos" "$@"
fi
exec "$here/heybotos" --no-sandbox "$@"
`,
)

const desktopEntry = (exec, icon) => `[Desktop Entry]
Type=Application
Name=HeyBotOS
GenericName=Agent team
Comment=A manager agent and a team of workers on your own coding CLI subscriptions
Exec=${exec} %U
Icon=${icon}
Terminal=false
Categories=Development;
StartupWMClass=HeyBotOS
`
// --only tar | deb | appimage makes just that one (the .tar.gz is always made: it is quick).
const only = flag('--only')
const made = []

// ── .tar.gz ──
{
  const out = join(OUT, `HeyBotOS-${version}-linux-${arch}.tar.gz`)
  run('tar', ['-czf', out, '-C', work, 'HeyBotOS'])
  made.push(out)
}

// ── .deb ──
if (only && only !== 'deb') {
  /* not asked for */
} else if (has('dpkg-deb')) {
  const pkg = join(work, 'deb')
  mkdirSync(join(pkg, 'DEBIAN'), { recursive: true })
  mkdirSync(join(pkg, 'opt'), { recursive: true })
  run('cp', ['-a', app, join(pkg, 'opt', 'HeyBotOS')])
  mkdirSync(join(pkg, 'usr', 'bin'), { recursive: true })
  run('ln', ['-s', '/opt/HeyBotOS/resources/heybotos/bin/heybotos', join(pkg, 'usr', 'bin', 'heybotos')])
  mkdirSync(join(pkg, 'usr', 'share', 'applications'), { recursive: true })
  writeFileSync(join(pkg, 'usr', 'share', 'applications', 'heybotos.desktop'), desktopEntry('/opt/HeyBotOS/heybotos-desktop', 'heybotos'))
  for (const size of [32, 48, 64, 128, 256, 512]) {
    const dir = join(pkg, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps')
    mkdirSync(dir, { recursive: true })
    cpSync(join(desktop, 'build', 'icons', `${size}.png`), join(dir, 'heybotos.png'))
  }
  run('chmod', ['-R', 'go-w,a+rX', pkg])
  const kb = Number(execFileSync('du', ['-sk', pkg], { encoding: 'utf8' }).split(/\s/)[0])
  writeFileSync(
    join(pkg, 'DEBIAN', 'control'),
    `Package: heybotos
Version: ${version}
Architecture: ${DEB_ARCH}
Maintainer: HeyBotOS contributors <heybotos@noreply.invalid>
Installed-Size: ${kb}
Section: devel
Priority: optional
Homepage: https://github.com/jannikco/heybotos
Depends: libgtk-3-0 | libgtk-3-0t64, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0 | libatspi2.0-0t64, libuuid1, libsecret-1-0, libgbm1, libasound2 | libasound2t64
Recommends: git, libayatana-appindicator3-1 | libappindicator3-1
Description: A manager agent and a team of worker agents on your own coding CLI subscriptions
 HeyBotOS is one manager agent you talk to in a local dashboard, which starts
 worker agents and shows everything they do. It runs the official coding CLIs
 (claude, codex, grok) with your own subscriptions; it has no account or key
 of its own. This is a beta.
`,
  )
  script(
    join(pkg, 'DEBIAN', 'postinst'),
    `#!/bin/sh
set -e
# Chromium's sandbox helper works when it belongs to root and has the setuid bit.
chown root:root /opt/HeyBotOS/chrome-sandbox || true
chmod 4755 /opt/HeyBotOS/chrome-sandbox || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
`,
  )
  script(
    join(pkg, 'DEBIAN', 'postrm'),
    `#!/bin/sh
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
exit 0
`,
  )
  const out = join(OUT, `heybotos_${version}_${DEB_ARCH}.deb`)
  rmSync(out, { force: true })
  run('dpkg-deb', ['--root-owner-group', '--build', pkg, out])
  rmSync(pkg, { recursive: true, force: true })
  made.push(out)
} else console.log('No dpkg-deb here: the .deb is skipped.')

// ── AppImage ──
if (only && only !== 'appimage') {
  /* not asked for */
} else if (has('mksquashfs')) {
  const dir = join(work, 'AppDir')
  mkdirSync(dir, { recursive: true })
  run('cp', ['-a', app, join(dir, 'app')])
  writeFileSync(join(dir, 'heybotos.desktop'), desktopEntry('AppRun', 'heybotos'))
  cpSync(join(desktop, 'build', 'icons', '512.png'), join(dir, 'heybotos.png'))
  cpSync(join(desktop, 'build', 'icons', '256.png'), join(dir, '.DirIcon'))
  script(
    join(dir, 'AppRun'),
    `#!/bin/sh
# An AppImage is mounted only while it runs, and HeyBotOS's service keeps running after the window
# is closed. So the app lives in the owner's data folder: copied there the first time, and again
# when this AppImage is a newer build than what is there.
here="$(dirname "$(readlink -f "$0")")"
data="\${XDG_DATA_HOME:-$HOME/.local/share}"
dest="$data/heybotos/app"
# The app also updates itself where it lives, so what is there may be newer than this file: only a
# missing copy, an older one, or another build of the same version is replaced.
mine="$(cut -d' ' -f1 "$here/app/resources/heybotos/BUILD")"
theirs="$(cut -d' ' -f1 "$dest/resources/heybotos/BUILD" 2>/dev/null)"
newest="$(printf '%s\\n%s\\n' "$theirs" "$mine" | sort -V | tail -n 1)"
if [ -z "$theirs" ] || { [ "$newest" = "$mine" ] && ! cmp -s "$here/app/resources/heybotos/BUILD" "$dest/resources/heybotos/BUILD"; }; then
  rm -rf "$dest.new"
  mkdir -p "$data/heybotos"
  cp -a "$here/app" "$dest.new" || { echo "HeyBotOS could not copy itself to $dest" >&2; exit 1; }
  rm -rf "$dest.old"
  [ -e "$dest" ] && mv "$dest" "$dest.old"
  mv "$dest.new" "$dest"
  rm -rf "$dest.old"
  # An entry in the applications menu, and the heybotos command where ~/.local/bin is on PATH.
  mkdir -p "$data/applications" "$data/icons/hicolor/512x512/apps" "$HOME/.local/bin"
  cp "$here/heybotos.png" "$data/icons/hicolor/512x512/apps/heybotos.png"
  sed -e "s|^Exec=.*|Exec=\\"$dest/heybotos-desktop\\" %U|" "$here/heybotos.desktop" > "$data/applications/heybotos.desktop"
  ln -sf "$dest/resources/heybotos/bin/heybotos" "$HOME/.local/bin/heybotos"
fi
exec "$dest/heybotos-desktop" "$@"
`,
  )
  const squash = join(work, 'app.squashfs')
  run('mksquashfs', [dir, squash, '-root-owned', '-noappend', '-comp', 'zstd', '-quiet', '-no-progress'])
  const out = join(OUT, `HeyBotOS-${version}-${APPIMAGE_ARCH}.AppImage`)
  writeFileSync(out, Buffer.concat([readFileSync(await tool(...RUNTIME)), readFileSync(squash)]))
  chmodSync(out, 0o755)
  rmSync(squash)
  rmSync(dir, { recursive: true, force: true })
  made.push(out)
} else console.log('No mksquashfs here (install squashfs-tools): the AppImage is skipped.')

console.log(`\nBuilt for Linux ${arch}:\n${made.map((f) => `  ${f}  (${(statSync(f).size / 1024 / 1024).toFixed(0)} MB)`).join('\n')}\n  ${app}/  (the app as a folder)`)
