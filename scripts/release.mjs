// Publishes a new version of HeyBotOS for all three systems, from start to finish:
//
//   pnpm release patch          (0.4.0 -> 0.4.1; also: minor, major, or a version such as 0.5.0)
//   pnpm release 0.5.0 --dry    (says what it would do, changes nothing)
//
// Before running it, write what changed under a "## Not released yet" heading at the top of
// CHANGELOG.md: that text becomes the release notes and what the app shows as "what is new".
//
// What it does, in order. Each step looks at what is already there, so after a failure the same
// command picks up where it stopped.
//   1. Sets the version everywhere and names the changelog section after it.
//   2. Runs the type check and the tests, commits, pushes, and waits for the GitHub check.
//   3. Builds the Mac app (apps/desktop/scripts/release.mjs) and creates the release with it.
//   4. Has GitHub build the Linux and Windows packages into the release, and waits.
//   5. Writes the list of updates (updates/latest.json), signs it with the project's key, and
//      pushes it. That is the moment installed apps start offering the new version.
//   6. Updates the Homebrew cask in the tap.
//
// It needs: a Mac, the gh command signed in, the tap checked out beside this repository (or
// HEYBOTOS_TAP pointing at it), and the key that signs updates (~/.heybotos-dev/update-key.pem, or
// HEYBOTOS_UPDATE_KEY). The key is not in the repository and must never be: whoever holds it can
// publish an update that every installed app accepts.
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dry = args.includes('--dry') || args.includes('--dry-run')
const want = args.find((a) => !a.startsWith('--'))
const REPO = 'jannikco/heybotos'
const PACKAGES = ['apps/daemon', 'apps/web', 'apps/desktop', 'packages/protocol']

const out = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: repo, stdio: 'inherit', ...opts })
const sh = (line) => run('/bin/sh', ['-c', line])
const step = (text) => console.log(`\n── ${text}`)
const stop = (text) => {
  console.error(`\n${text}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (path) => JSON.parse(readFileSync(join(repo, path), 'utf8'))

// ── which version ──
const pkg = json('package.json')
const stage = pkg.stage ?? ''
function next(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how ?? '')) return how
  const [a, b, c] = current.split('.').map(Number)
  if (how === 'patch') return `${a}.${b}.${c + 1}`
  if (how === 'minor') return `${a}.${b + 1}.0`
  if (how === 'major') return `${a + 1}.0.0`
  stop('Say which version: pnpm release patch | minor | major | 0.5.0   (add --dry to only see what would happen)')
}
const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')
// A run that stopped half-way has already set the version: the same command then means that version.
const resuming = !changelog.includes('## Not released yet') && new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}( |$)`, 'm').test(changelog) && !released(pkg.version)
const version = resuming && !/^\d/.test(want ?? '') ? pkg.version : next(pkg.version, want)
const tag = `v${version}`
const heading = `## ${version}${stage ? ` (${stage})` : ''}`

function released(v) {
  try {
    return existsSync(join(repo, 'updates', 'latest.json')) && json('updates/latest.json').version === v
  } catch {
    return false
  }
}

/** The part of the changelog that belongs to this version. */
function notes() {
  const text = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')
  const at = text.indexOf(heading) >= 0 ? text.indexOf(heading) : text.indexOf('## Not released yet')
  if (at < 0) return ''
  const body = text.slice(text.indexOf('\n', at) + 1)
  const end = body.search(/^## /m)
  return (end < 0 ? body : body.slice(0, end)).trim()
}

// ── before anything is touched ──
if (process.platform !== 'darwin') stop('A release is made on a Mac: the Mac app is built here.')
if (out('git', ['branch', '--show-current']) !== 'main') stop('Releases are made from the main branch.')
if (!notes()) stop(`Write what changed first: put it under a "## Not released yet" heading at the top of CHANGELOG.md.`)
const keyFile = process.env.HEYBOTOS_UPDATE_KEY || join(homedir(), '.heybotos-dev', 'update-key.pem')
if (!existsSync(keyFile)) stop(`The key that signs updates is not at ${keyFile}. Without it installed apps would not accept this version.`)
const key = createPrivateKey(readFileSync(keyFile))
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
const expected = /UPDATES_KEY = '([^']+)'/.exec(readFileSync(join(repo, 'apps', 'daemon', 'src', 'updates.ts'), 'utf8'))?.[1]
if (publicKey !== expected) stop(`The key at ${keyFile} is not the one installed apps trust (UPDATES_KEY in apps/daemon/src/updates.ts).`)
const tap = process.env.HEYBOTOS_TAP || join(repo, '..', 'homebrew-tap')
if (!existsSync(join(tap, 'Casks', 'heybotos.rb'))) stop(`The Homebrew tap is not at ${tap}. Check it out there, or set HEYBOTOS_TAP.`)
// The release commits what it changes itself. Anything else that is unfinished would go out with it.
const mine = new Set(['package.json', 'CHANGELOG.md', ...PACKAGES.map((p) => `${p}/package.json`), 'updates/latest.json', 'updates/latest.json.sig'])
const others = out('git', ['status', '--porcelain'])
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3))
  .filter((f) => !mine.has(f))
if (others.length) stop(`There are changes that are not part of a release:\n${others.map((f) => `  ${f}`).join('\n')}\nCommit them (or put them aside) first, so the release contains only what you meant.`)
try {
  out('gh', ['auth', 'status'])
} catch {
  stop('The gh command is not signed in: run "gh auth login".')
}

console.log(`HeyBotOS ${pkg.version} -> ${version}${stage ? ` (${stage})` : ''}${resuming ? ', picking up a release that was started' : ''}${dry ? '   [dry run: nothing is changed]' : ''}`)
console.log(`\nWhat is new:\n${notes()
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}`)
if (dry) {
  console.log(`\nWould: set the version, run the checks, commit and push, wait for GitHub, build the Mac app, create release ${tag}, have GitHub add the Linux and Windows packages, sign and push updates/latest.json, and update the cask in ${tap}.`)
  process.exit(0)
}

// ── 1. the version ──
step(`Version ${version}`)
for (const p of ['.', ...PACKAGES]) {
  const file = join(repo, p, 'package.json')
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(/"version": "[^"]+"/, `"version": "${version}"`))
}
if (changelog.includes('## Not released yet')) writeFileSync(join(repo, 'CHANGELOG.md'), changelog.replace('## Not released yet', heading))

// ── 2. checks, commit, push, GitHub's check ──
const dirty = () => out('git', ['status', '--porcelain']) !== ''
if (dirty()) {
  step('Type check and tests')
  sh('pnpm typecheck && pnpm test')
  step('Commit and push')
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', version])
}
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', '@{u}'])) run('git', ['push', '-q', 'origin', 'main'])
const head = out('git', ['rev-parse', 'HEAD'])

async function waitForRun(find, what) {
  let id = ''
  for (let i = 0; i < 60 && !id; i++) {
    id = find()
    if (!id) await sleep(5000)
  }
  if (!id) stop(`GitHub never started ${what}.`)
  for (;;) {
    const r = JSON.parse(out('gh', ['run', 'view', id, '--repo', REPO, '--json', 'status,conclusion']))
    if (r.status === 'completed') {
      if (r.conclusion !== 'success') stop(`${what} did not pass on GitHub: https://github.com/${REPO}/actions/runs/${id}\nFix it and run the same command again.`)
      return
    }
    await sleep(20_000)
  }
}
step('Waiting for the GitHub check of this commit')
await waitForRun(() => out('gh', ['run', 'list', '--repo', REPO, '--workflow', 'ci.yml', '--branch', 'main', '--limit', '10', '--json', 'databaseId,headSha', '--jq', `[.[] | select(.headSha=="${head}")][0].databaseId // ""`]), 'The check')

// ── 3. the Mac app and the release ──
const dist = join(repo, 'apps', 'desktop', 'dist')
const macZips = ['arm64', 'x64'].map((a) => join(dist, `HeyBotOS-${version}-${a}.zip`))
const builtFrom = () => {
  try {
    return readFileSync(join(dist, 'arm64', 'HeyBotOS.app', 'Contents', 'Resources', 'heybotos', 'BUILD'), 'utf8').split(' ')[2]
  } catch {
    return ''
  }
}
const assets = () => JSON.parse(out('gh', ['api', `repos/${REPO}/releases/tags/${tag}`, '--jq', '[.assets[] | {name, size, digest}]']))
let have = null
try {
  have = assets()
} catch {
  /* no release yet */
}
// Built once per release: what is in the release must stay the file whose checksum is published.
if (!macZips.every(existsSync) || (!have && !head.startsWith(builtFrom() || '?'))) {
  if (have) stop(`Release ${tag} exists, but the Mac files it was made from are no longer in apps/desktop/dist. Delete the release on GitHub and run the same command again.`)
  step('Building the Mac app')
  run('node', [join('apps', 'desktop', 'scripts', 'release.mjs')])
}
if (!have) {
  step(`Creating release ${tag}`)
  const body = `${stage === 'beta' ? '**This is a beta.** Expect rough edges and changes between versions. Workers edit files and run commands on your computer without asking first: start with projects that are in git.\n\n' : ''}## What is new\n\n${notes()}\n\n## Install or update\n\nIf you have HeyBotOS 0.5.0 or newer, it offers this version itself: Settings, General, Version.\n\n| System | File |\n|---|---|\n| macOS | \`brew install --cask jannikco/tap/heybotos\`, or \`HeyBotOS-${version}-arm64.zip\` (Apple silicon) / \`-x64.zip\` (Intel) |\n| Debian, Ubuntu, Mint | \`heybotos_${version}_amd64.deb\` or \`_arm64.deb\` |\n| Other Linux | \`HeyBotOS-${version}-x86_64.AppImage\` or \`-aarch64.AppImage\` |\n| Windows 10 and 11 (experimental) | \`HeyBotOS-${version}-win-x64-setup.exe\` |\n\nThe apps are not signed yet, so macOS and Windows ask before they let a first install through. The [README](https://github.com/${REPO}#install) says how.\n`
  const file = join(dist, 'release-notes.md')
  writeFileSync(file, body)
  run('gh', ['release', 'create', tag, ...macZips, '--repo', REPO, '--title', `HeyBotOS ${version}${stage ? ` (${stage})` : ''}`, ...(stage ? ['--prerelease'] : []), '--notes-file', file, '--target', 'main'])
} else if (!macZips.every((z) => have.some((a) => z.endsWith(a.name)))) run('gh', ['release', 'upload', tag, ...macZips, '--repo', REPO, '--clobber'])

// ── 4. Linux and Windows, built by GitHub ──
const FILES = {
  'darwin-arm64': `HeyBotOS-${version}-arm64.zip`,
  'darwin-x64': `HeyBotOS-${version}-x64.zip`,
  'linux-x64': `HeyBotOS-${version}-linux-x64.tar.gz`,
  'linux-arm64': `HeyBotOS-${version}-linux-arm64.tar.gz`,
  'win32-x64': `HeyBotOS-${version}-win-x64-setup.exe`,
  'deb-x64': `heybotos_${version}_amd64.deb`,
  'deb-arm64': `heybotos_${version}_arm64.deb`,
}
const complete = () => {
  const names = assets().map((a) => a.name)
  return Object.values(FILES).every((f) => names.includes(f))
}
if (!complete()) {
  step('Having GitHub build the Linux and Windows packages (about ten minutes)')
  const before = out('gh', ['run', 'list', '--repo', REPO, '--workflow', 'release.yml', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""'])
  run('gh', ['workflow', 'run', 'release.yml', '--repo', REPO, '-f', `tag=${tag}`])
  await waitForRun(() => {
    const id = out('gh', ['run', 'list', '--repo', REPO, '--workflow', 'release.yml', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""'])
    return id !== before ? id : ''
  }, 'Building the packages')
  if (!complete()) stop('The packages were built, but some are missing from the release. Look at the release page and run the same command again.')
}

// ── 5. the signed list of updates ──
step('Signing and publishing the list of updates')
const all = assets()
const files = {}
for (const [kind, name] of Object.entries(FILES)) {
  const a = all.find((x) => x.name === name)
  const sha = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1]
  if (!sha) stop(`GitHub gives no checksum for ${name}.`)
  // The two files built here are checked against what GitHub holds; the others were built there.
  const local = join(dist, name)
  if (existsSync(local) && createHash('sha256').update(readFileSync(local)).digest('hex') !== sha) stop(`${name} on GitHub is not the file that was built here.`)
  files[kind] = { url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, sha256: sha, size: a.size }
}
const manifest = `${JSON.stringify({ version, notes: notes(), published: new Date().toISOString(), page: `https://github.com/${REPO}/releases/tag/${tag}`, files }, null, 2)}\n`
const signature = sign(null, Buffer.from(manifest, 'utf8'), key).toString('base64')
if (!verify(null, Buffer.from(manifest, 'utf8'), createPublicKey(key), Buffer.from(signature, 'base64'))) stop('The signature just made does not verify.')
mkdirSync(join(repo, 'updates'), { recursive: true })
writeFileSync(join(repo, 'updates', 'latest.json'), manifest)
writeFileSync(join(repo, 'updates', 'latest.json.sig'), `${signature}\n`)
if (dirty()) {
  run('git', ['add', 'updates'])
  // Nothing but the list changed: the check has nothing new to say about it.
  run('git', ['commit', '-q', '-m', `Offer ${version} to installed apps\n\n[skip ci]`])
  run('git', ['push', '-q', 'origin', 'main'])
}

// ── 6. Homebrew ──
step('Updating the Homebrew cask')
const cask = readFileSync(join(dist, 'heybotos.rb'), 'utf8')
if (!cask.includes(`version "${version}"`)) stop(`apps/desktop/dist/heybotos.rb is not for ${version}. Run the same command again.`)
if (readFileSync(join(tap, 'Casks', 'heybotos.rb'), 'utf8') !== cask) {
  writeFileSync(join(tap, 'Casks', 'heybotos.rb'), cask)
  run('git', ['add', 'Casks/heybotos.rb'], { cwd: tap })
  run('git', ['commit', '-q', '-m', `heybotos ${version}`], { cwd: tap })
  run('git', ['push', '-q', 'origin', 'HEAD'], { cwd: tap })
}

console.log(`\nHeyBotOS ${version} is out.
  Release        https://github.com/${REPO}/releases/tag/${tag}
  Installed apps offer it within about six hours, or at once with "Look now" in Settings.
  Homebrew       brew upgrade --cask jannikco/tap/heybotos`)
