// Updates: finding out that there is a newer HeyBotOS, fetching it, and making sure it is the real
// thing before anything installs it.
//
// The project publishes a small list (a "manifest") with the newest version and one file per system,
// each with its size and checksum. The list is signed with a key only the project holds; the
// matching public key is below. A list that does not verify is ignored, and a downloaded file whose
// checksum differs from the list is thrown away. The service only fetches and checks: replacing the
// app is done by the desktop app, which has to close first.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UpdateState } from '@heybotos/protocol'
import type { Bus } from './bus.ts'
import type { Home } from './home.ts'
import { LINUX, MAC, WIN } from './platform.ts'

/** Where the list of the newest version is published. A fork that publishes its own changes this and the key. */
export const UPDATES_URL = 'https://raw.githubusercontent.com/jannikco/heybotos/main/updates/latest.json'
/** The public half of the key the project signs that list with (Ed25519). */
export const UPDATES_KEY = 'MCowBQYDK2VwAyEAzn5PbGJRT2K8R/HPxUtpWXj3y14nz4SLDUwRPxJxAa8='

export interface ManifestFile {
  url: string
  sha256: string
  size: number
}
export interface Manifest {
  version: string
  /** What changed, as the changelog says it. */
  notes: string
  published: string
  /** A page a person can read about this version. */
  page: string
  /** One per kind of install: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, deb-x64, deb-arm64. */
  files: Record<string, ManifestFile>
}

const VERSION = /^\d+\.\d+\.\d+$/
/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) - (y![i] ?? 0)
  return 0
}

const keyOf = (base64: string) => createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })

/**
 * Read a signed list. Throws unless the signature is the project's and every field is what it is
 * meant to be: nothing from the list is used before this has passed.
 */
export function readManifest(text: string, signature: string, key = UPDATES_KEY): Manifest {
  let ok = false
  try {
    ok = verify(null, Buffer.from(text, 'utf8'), keyOf(key), Buffer.from(signature.trim(), 'base64'))
  } catch {
    ok = false
  }
  if (!ok) throw new Error('The list of updates is not signed by the HeyBotOS project, so it was ignored.')
  const m = JSON.parse(text) as Manifest
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) throw new Error('The list of updates names no proper version.')
  if (m.files === null || typeof m.files !== 'object') throw new Error('The list of updates has no files.')
  for (const [name, f] of Object.entries(m.files)) {
    if (typeof f?.url !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256)) || !Number.isInteger(f.size) || f.size <= 0) throw new Error(`The list of updates describes "${name}" badly.`)
    if (!allowedUrl(f.url)) throw new Error(`The list of updates points "${name}" at an address HeyBotOS does not fetch from.`)
  }
  return { version: m.version, notes: typeof m.notes === 'string' ? m.notes.slice(0, 20_000) : '', published: typeof m.published === 'string' ? m.published : '', page: typeof m.page === 'string' && allowedUrl(m.page) ? m.page : '', files: m.files }
}

/** Only encrypted addresses, except this computer itself (which is how the tests serve an update). */
function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export interface UpdatesOptions {
  /** The version that is running. */
  version: string
  /** The folder of the installed app this service runs from, or null when it runs from the source code. */
  app: string | null
  url?: string
  key?: string
}

/** The installed app, seen from the service that runs inside it; null from the source code. */
export function installedApp(): string | null {
  if (!process.versions.electron) return null
  // macOS: …/HeyBotOS.app/Contents/MacOS/HeyBotOS. Elsewhere the program sits in the app's folder.
  return MAC ? join(dirname(process.execPath), '..', '..') : dirname(process.execPath)
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export class Updates {
  private home: Home
  private bus: Bus
  private opts: UpdatesOptions
  private dir: string
  private manifest: Manifest | null = null
  private status: UpdateState['status'] = 'idle'
  private progress: number | null = null
  private problem: string | null = null
  private checkedAt: number | null = null
  private file: string | null = null
  private busy: Promise<UpdateState> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(home: Home, bus: Bus, opts: UpdatesOptions) {
    this.home = home
    this.bus = bus
    this.opts = opts
    this.dir = join(home.state, 'updates')
  }

  /**
   * How this copy gets a new version: "app" when the desktop app can replace itself, "package" when
   * the system's package manager has to (a .deb in a folder only root can write, or an app folder
   * this account cannot write), "source" when it runs from the source code.
   */
  private how(): UpdateState['how'] {
    const app = this.opts.app
    if (!app) return 'source'
    if (WIN) return 'app'
    return writable(app) && writable(dirname(app)) ? 'app' : 'package'
  }

  /** The file in the list that fits this copy. */
  private wanted(): { key: string; file: ManifestFile } | null {
    if (!this.manifest) return null
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const key = LINUX && this.how() === 'package' ? `deb-${arch}` : `${process.platform}-${arch}`
    const file = this.manifest.files[key]
    return file ? { key, file } : null
  }

  private newer(): boolean {
    return this.manifest !== null && compareVersions(this.manifest.version, this.opts.version) > 0
  }

  private hint(): string | null {
    const how = this.how()
    if (how === 'source') return 'This copy runs from the source code: update it with "git pull", then "pnpm install" and "pnpm build".'
    if (how === 'app' || !this.newer()) return null
    if (MAC) return 'HeyBotOS cannot replace itself where it is installed. Update it with: brew upgrade --cask jannikco/tap/heybotos'
    if (this.file) return `Install it with: sudo apt install "${this.file}"`
    return this.wanted() ? 'It was installed as a package, so the system has to install the new one. Download it here, then install it with apt.' : `Get the new version from ${this.manifest?.page || 'the releases page'}.`
  }

  state(): UpdateState {
    const m = this.newer() ? this.manifest : null
    return {
      current: this.opts.version,
      latest: m ? { version: m.version, notes: m.notes, published: m.published || null, page: m.page } : null,
      checkedAt: this.checkedAt,
      status: this.status,
      progress: this.progress,
      problem: this.problem,
      how: this.how(),
      hint: this.hint(),
      file: this.status === 'ready' ? this.file : null,
      auto: this.home.config.updates.auto,
    }
  }

  private set(status: UpdateState['status'], more: { problem?: string | null; progress?: number | null } = {}): UpdateState {
    this.status = status
    this.problem = more.problem ?? null
    this.progress = more.progress ?? null
    const s = this.state()
    this.bus.emit('update', s)
    return s
  }

  private once(work: () => Promise<UpdateState>): Promise<UpdateState> {
    this.busy ??= work().finally(() => {
      this.busy = null
    })
    return this.busy
  }

  /** Ask whether there is a newer version. Never throws: what went wrong is in the state. */
  check(): Promise<UpdateState> {
    return this.once(async () => {
      const was = this.status
      if (was !== 'downloading') this.set('checking')
      try {
        const url = this.home.config.updates.url || this.opts.url || UPDATES_URL
        const get = async (u: string) => {
          const res = await fetch(u, { headers: { 'user-agent': `HeyBotOS/${this.opts.version}`, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) })
          if (!res.ok) throw new Error(`The list of updates could not be fetched (${res.status}).`)
          return res.text()
        }
        const manifest = readManifest(await get(url), await get(`${url}.sig`), this.home.config.updates.publicKey || this.opts.key || UPDATES_KEY)
        this.checkedAt = Date.now()
        // A file fetched for an older list is of no use any more.
        if (this.manifest && this.manifest.version !== manifest.version) this.file = null
        this.manifest = manifest
        this.sweep()
        return this.set(this.newer() ? (this.file ? 'ready' : 'available') : 'idle')
      } catch (e) {
        this.checkedAt = Date.now()
        const offline = (e as Error).name === 'TimeoutError' || /fetch failed/i.test((e as Error).message)
        return this.set(this.newer() ? (this.file ? 'ready' : 'available') : 'failed', { problem: offline ? 'Could not reach the place updates are published. Are you online?' : (e as Error).message })
      }
    })
  }

  /** Fetch the new version and check it against the list. Resolves when it is ready, or when it failed. */
  download(): Promise<UpdateState> {
    if (this.status === 'ready' && this.file && existsSync(this.file)) return Promise.resolve(this.state())
    return this.once(async () => {
      const want = this.newer() ? this.wanted() : null
      if (!want) return this.set(this.newer() ? 'failed' : 'idle', { problem: this.newer() ? 'There is no download of the new version for this kind of computer.' : null })
      const name = decodeURIComponent(new URL(want.file.url).pathname.split('/').pop() || 'update').replace(/[^A-Za-z0-9._-]/g, '_')
      // A package the owner installs by hand goes where they will find it.
      const downloads = join(homedir(), 'Downloads')
      const into = this.how() === 'package' && existsSync(downloads) ? downloads : this.dir
      const target = join(into, name)
      const part = join(this.dir, `${name}.part`)
      try {
        mkdirSync(this.dir, { recursive: true })
        this.set('downloading', { progress: 0 })
        const res = await fetch(want.file.url, { headers: { 'user-agent': `HeyBotOS/${this.opts.version}` }, redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(`The download was refused (${res.status}).`)
        const hash = createHash('sha256')
        const out = createWriteStream(part)
        let got = 0
        let told = 0
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          got += chunk.length
          if (got > want.file.size) throw new Error('The download is larger than the list of updates says it should be.')
          hash.update(chunk)
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
          if (got - told > want.file.size / 50) {
            told = got
            this.set('downloading', { progress: got / want.file.size })
          }
        }
        await new Promise<void>((done, fail) => out.end((e?: Error | null) => (e ? fail(e) : done())))
        if (got !== want.file.size || hash.digest('hex') !== want.file.sha256) throw new Error('The download is not the file the HeyBotOS project published, so it was thrown away.')
        renameSync(part, target)
        this.file = target
        return this.set('ready')
      } catch (e) {
        rmSync(part, { force: true })
        return this.set('failed', { problem: (e as Error).message })
      }
    })
  }

  /** Clear away downloads that are no longer the newest. */
  private sweep(): void {
    if (!existsSync(this.dir)) return
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name)
      if (path === this.file) continue
      // Whatever a finished install left behind, and files that are a day old.
      try {
        if (name.endsWith('.part') || Date.now() - statSync(path).mtimeMs > 24 * 3600_000) rmSync(path, { recursive: true, force: true })
      } catch {
        /* in use: next time */
      }
    }
  }

  /** Look for updates now and then, when the owner has not switched that off. */
  start(): void {
    const look = () => {
      if (this.home.config.updates.auto && this.how() !== 'source') void this.check()
    }
    setTimeout(look, 15_000).unref()
    this.timer = setInterval(look, 6 * 3600_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
