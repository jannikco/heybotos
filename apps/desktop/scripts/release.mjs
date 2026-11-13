// Makes a release of the Mac app: checks that the service runs on the app's own runtime, builds the
// app for Apple silicon and Intel, signs it (and has Apple notarise it when a Developer ID is given),
// zips each build, and writes the Homebrew cask with their checksums. The Linux and Windows packages
// are built by GitHub (the workflow release.yml) and added to the release afterwards.
//
//   node scripts/release.mjs
//
// With a Developer ID:
//   HEYBOTOS_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
//   HEYBOTOS_NOTARY_PROFILE="a profile saved with: xcrun notarytool store-credentials" \
//   node scripts/release.mjs
//
// Nothing is uploaded. The last lines say what to run to publish.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..', '..')
const { version, stage } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const identity = process.env.HEYBOTOS_SIGN_IDENTITY
const notary = process.env.HEYBOTOS_NOTARY_PROFILE
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts })
const step = (text) => console.log(`\n── ${text}`)

step('Building the dashboard')
run('/bin/sh', ['-c', 'pnpm build'])

if (!process.argv.includes('--skip-tests')) {
  // Users get the service on Electron's Node, not on the Node it is developed with.
  step("Running the service's tests on the app's own runtime")
  const electron = createRequire(join(desktop, 'package.json'))('electron')
  run(electron, [join('node_modules', 'vitest', 'vitest.mjs'), 'run'], { cwd: join(repo, 'apps', 'daemon'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
}

const sums = {}
for (const arch of ['arm64', 'x64']) {
  step(`Building the app for ${arch === 'arm64' ? 'Apple silicon' : 'Intel'}`)
  run('node', [join('apps', 'desktop', 'scripts', 'make-app.mjs'), '--arch', arch])
  const app = join(desktop, 'dist', arch, 'HeyBotOS.app')
  const zip = join(desktop, 'dist', `HeyBotOS-${version}-${arch}.zip`)
  rmSync(zip, { force: true })
  const pack = () => run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  pack()
  if (identity && notary) {
    step(`Having Apple notarise the ${arch} build`)
    run('/usr/bin/xcrun', ['notarytool', 'submit', zip, '--keychain-profile', notary, '--wait'])
    run('/usr/bin/xcrun', ['stapler', 'staple', app])
    // The zip that ships is made again, now with the ticket attached to the app inside it.
    rmSync(zip)
    pack()
  }
  sums[arch] = createHash('sha256').update(readFileSync(zip)).digest('hex')
}

const notarised = Boolean(identity && notary)
const cask = `cask "heybotos" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sums.arm64}",
         intel: "${sums.x64}"

  url "https://github.com/jannikco/heybotos/releases/download/v#{version}/HeyBotOS-#{version}-#{arch}.zip"
  name "HeyBotOS"
  desc "Manager agent and a team of worker agents on your own coding CLI subscriptions"
  homepage "https://github.com/jannikco/heybotos"

  # While HeyBotOS is in beta its releases are pre-releases, which the usual check skips.
  livecheck do
    url :url
    regex(/^v?(\\d+(?:\\.\\d+)+)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end

  # The app fetches and installs newer versions itself (Settings > General > Version).
  auto_updates true
  depends_on macos: :monterey

  app "HeyBotOS.app"
  binary "#{appdir}/HeyBotOS.app/Contents/Resources/heybotos/bin/heybotos"

  uninstall launchctl: "com.heybotos.daemon",
            quit:      "com.heybotos.app"

  zap trash: [
    "~/heybotos",
    "~/Library/Application Support/HeyBotOS",
    "~/Library/Preferences/com.heybotos.app.plist",
    "~/Library/Saved Application State/com.heybotos.app.savedState",
  ]

  caveats <<~EOS
${stage === 'beta' ? `    HeyBotOS is in beta: expect rough edges and changes between versions. Its
    workers edit files and run commands without asking first, so start with
    projects that are in git.

` : ''}    HeyBotOS runs the official coding CLIs with your own subscriptions. Install and
    sign in to at least one of: claude, codex, grok.
${
  notarised
    ? ''
    : `
    This build is not notarised by Apple, so macOS stops it the first time you
    open it. Choose OK in that message (not "Move to Trash"), then go to System
    Settings > Privacy & Security, scroll to Security and choose "Open Anyway".
`
}
    Open HeyBotOS once after installing or upgrading: the app sets up and starts
    its background service.
  EOS
end
`
const caskFile = join(desktop, 'dist', 'heybotos.rb')
writeFileSync(caskFile, cask)

step('Done')
console.log(`Version ${version}, ${identity ? (notarised ? 'signed and notarised' : 'signed with a Developer ID, not notarised') : 'signed ad hoc (no Developer ID given)'}.
  ${join(desktop, 'dist', `HeyBotOS-${version}-arm64.zip`)}
  ${join(desktop, 'dist', `HeyBotOS-${version}-x64.zip`)}
  ${caskFile}

To publish:
  gh release create v${version} apps/desktop/dist/HeyBotOS-${version}-arm64.zip apps/desktop/dist/HeyBotOS-${version}-x64.zip --title "HeyBotOS ${version}${stage ? ` (${stage})` : ''}"${stage ? ' --prerelease' : ''} --notes-file CHANGELOG.md
  then copy apps/desktop/dist/heybotos.rb to Casks/heybotos.rb in the tap repository and push it,
  and add the Linux and Windows packages, which GitHub builds:  gh workflow run release.yml -f tag=v${version}`)
if (!existsSync(join(repo, 'LICENSE'))) console.warn('Note: there is no LICENSE file in the repository.')
