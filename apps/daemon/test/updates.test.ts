// Finding, fetching and checking a newer version. The "project" here is a small web server on this
// computer with a key of its own: nothing is fetched from the real project.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateState } from '@heybotos/protocol'
import { compareVersions, readManifest, Updates, type Manifest } from '../src/updates.ts'
import { makeWorld, type World } from './helpers.ts'

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signWith: (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64') }
}
const project = pair()
const stranger = pair()
const PACKAGE = Buffer.from('the new version, as a file')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const THIS = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

let w: World
let server: Server
let base: string
/** What the stand-in project publishes; a test changes it to act out a case. */
let published: { text: string; signature: string; file: Buffer }
let fetched: string[]

function publish(over: Partial<Manifest> = {}, more: { signer?: typeof project; file?: Buffer; describe?: Partial<Manifest['files'][string]> } = {}): void {
  const file = more.file ?? PACKAGE
  const manifest: Manifest = {
    version: '9.1.0',
    notes: '- Something new.',
    published: '2026-01-02T03:04:05Z',
    page: 'https://example.org/releases/9.1.0',
    files: { [THIS]: { url: `${base}/HeyBotOS-9.1.0.pkg`, sha256: sha(PACKAGE), size: PACKAGE.length, ...more.describe } },
    ...over,
  }
  const text = JSON.stringify(manifest, null, 2)
  published = { text, signature: (more.signer ?? project).signWith(text), file }
}

beforeEach(async () => {
  w = makeWorld()
  fetched = []
  server = createServer((req, res) => {
    fetched.push(req.url ?? '')
    if (req.url === '/latest.json') return void res.end(published.text)
    if (req.url === '/latest.json.sig') return void res.end(published.signature)
    if (req.url === '/HeyBotOS-9.1.0.pkg') return void res.end(published.file)
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  publish()
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  w.cleanup()
})

/** An installed app this account may write to, so it can replace itself. */
function installed(): string {
  const app = join(w.root, 'apps', 'HeyBotOS')
  mkdirSync(app, { recursive: true })
  return app
}
const updates = (version = '9.0.0', app: string | null = installed()) => new Updates(w.home, w.bus, { version, app, url: `${base}/latest.json`, key: project.key })

describe('the list of updates', () => {
  it('orders versions by their numbers, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.4.0', '0.4.1')).toBeLessThan(0)
  })

  it('is read only when the project signed exactly this text', () => {
    expect(readManifest(published.text, published.signature, project.key).version).toBe('9.1.0')
    expect(() => readManifest(published.text, stranger.signWith(published.text), project.key)).toThrow(/not signed by the HeyBotOS project/)
    expect(() => readManifest(published.text.replace('9.1.0', '9.9.0'), published.signature, project.key)).toThrow(/not signed/)
    expect(() => readManifest(published.text, 'not a signature', project.key)).toThrow(/not signed/)
  })

  it('is refused when it points anywhere but an encrypted address', () => {
    const sly = JSON.stringify({ version: '9.1.0', files: { [THIS]: { url: 'http://example.org/x.pkg', sha256: sha(PACKAGE), size: 3 } } })
    expect(() => readManifest(sly, project.signWith(sly), project.key)).toThrow(/an address HeyBotOS does not fetch from/)
    const vague = JSON.stringify({ version: 'newest', files: {} })
    expect(() => readManifest(vague, project.signWith(vague), project.key)).toThrow(/no proper version/)
  })
})

describe('looking for a newer version', () => {
  it('finds one, says what is new, and tells whoever listens', async () => {
    const seen: UpdateState[] = []
    w.bus.on('update', (s) => seen.push(s))
    const u = updates()
    expect(u.state()).toMatchObject({ current: '9.0.0', latest: null, status: 'idle', how: 'app' })
    const s = await u.check()
    expect(s).toMatchObject({ status: 'available', latest: { version: '9.1.0', notes: '- Something new.', page: 'https://example.org/releases/9.1.0' }, problem: null, file: null })
    expect(s.checkedAt).toBeGreaterThan(0)
    expect(seen.map((x) => x.status)).toEqual(['checking', 'available'])
  })

  it('stays quiet when this version is the newest, or newer than what is published', async () => {
    expect(await updates('9.1.0').check()).toMatchObject({ status: 'idle', latest: null })
    expect(await updates('9.2.0').check()).toMatchObject({ status: 'idle', latest: null })
  })

  it('ignores a list somebody else signed, and says why', async () => {
    publish({}, { signer: stranger })
    expect(await updates().check()).toMatchObject({ status: 'failed', latest: null, problem: expect.stringMatching(/not signed by the HeyBotOS project/) })
  })

  it('says so when the place updates are published cannot be reached', async () => {
    const u = new Updates(w.home, w.bus, { version: '9.0.0', app: installed(), url: 'http://127.0.0.1:9/latest.json', key: project.key })
    expect(await u.check()).toMatchObject({ status: 'failed', problem: expect.stringMatching(/Are you online/) })
  })
})

describe('fetching it', () => {
  it('fetches the file for this kind of computer and keeps it only when it is the published one', async () => {
    const u = updates()
    await u.check()
    const progress: number[] = []
    w.bus.on('update', (s) => s.status === 'downloading' && progress.push(s.progress ?? -1))
    const s = await u.download()
    expect(s).toMatchObject({ status: 'ready', problem: null })
    expect(readFileSync(s.file!)).toEqual(PACKAGE)
    expect(s.file!.startsWith(join(w.home.state, 'updates'))).toBe(true)
    expect(progress[0]).toBe(0)
    // Asked again, it does not fetch again.
    const before = fetched.length
    expect((await u.download()).file).toBe(s.file)
    expect(fetched.length).toBe(before)
  })

  it('throws away a file that is not the published one', async () => {
    publish({}, { file: Buffer.from('the new version, as a fake') })
    const u = updates()
    await u.check()
    const s = await u.download()
    expect(s).toMatchObject({ status: 'failed', file: null, problem: expect.stringMatching(/not the file the HeyBotOS project published/) })
    expect(existsSync(join(w.home.state, 'updates', 'HeyBotOS-9.1.0.pkg'))).toBe(false)
    expect(existsSync(join(w.home.state, 'updates', 'HeyBotOS-9.1.0.pkg.part'))).toBe(false)
  })

  it('stops a download that grows past the size the list gives', async () => {
    publish({}, { file: Buffer.concat([PACKAGE, Buffer.alloc(4096)]) })
    const u = updates()
    await u.check()
    expect(await u.download()).toMatchObject({ status: 'failed', problem: expect.stringMatching(/larger than the list of updates says/) })
  })

  it('has nothing to fetch when no file fits this computer, or nothing is newer', async () => {
    publish({ files: { 'other-system': { url: `${base}/HeyBotOS-9.1.0.pkg`, sha256: sha(PACKAGE), size: PACKAGE.length } } })
    const u = updates()
    await u.check()
    expect(await u.download()).toMatchObject({ status: 'failed', problem: expect.stringMatching(/no download of the new version for this kind of computer/) })
    const current = updates('9.1.0')
    await current.check()
    expect(await current.download()).toMatchObject({ status: 'idle', file: null })
  })
})

describe('how this copy is updated', () => {
  it('is by "git pull" from the source code, and nothing is fetched', async () => {
    const u = updates('9.0.0', null)
    expect(u.state()).toMatchObject({ how: 'source', hint: expect.stringMatching(/git pull/) })
  })

  // Windows installs for one person, in a folder that person can always write.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('is by the package manager when the app sits where this account cannot write', async () => {
    const locked = join(w.root, 'opt')
    mkdirSync(join(locked, 'HeyBotOS'), { recursive: true })
    chmodSync(join(locked, 'HeyBotOS'), 0o555)
    chmodSync(locked, 0o555)
    try {
      const u = updates('9.0.0', join(locked, 'HeyBotOS'))
      expect(u.state()).toMatchObject({ how: 'package', hint: null })
      const s = await u.check()
      expect(s).toMatchObject({ status: 'available', how: 'package' })
      expect(s.hint).toBeTruthy()
    } finally {
      chmodSync(locked, 0o755)
      chmodSync(join(locked, 'HeyBotOS'), 0o755)
    }
  })

  it('looks by itself unless the owner switched that off, which is kept', () => {
    expect(w.settings.read().general.autoUpdate).toBe(true)
    w.settings.apply({ general: { autoUpdate: false } })
    expect(w.home.config.updates.auto).toBe(false)
    expect(JSON.parse(readFileSync(join(w.home.configDir, 'heybotos.json'), 'utf8')).updates.auto).toBe(false)
    expect(updates().state().auto).toBe(false)
  })
})
