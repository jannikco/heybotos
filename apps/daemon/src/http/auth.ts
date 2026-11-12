// Who may talk to the daemon.
//
// The daemon can start agents that run without asking, so "it only listens on localhost" is not
// enough: any web page open in the browser can send requests to localhost. Three checks close that:
// the Host header must be ours (stops DNS rebinding), a cross-site Origin is refused, and every
// API call needs either the session cookie (browser) or the shared secret (local tools).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db.ts'
import type { Home } from '../home.ts'

const COOKIE = 'heybotos_session'
const SESSION_DAYS = 180

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(sha(a))
  const y = Buffer.from(sha(b))
  return timingSafeEqual(x, y)
}

export class Auth {
  private loginToken = ''
  readonly hosts: Set<string>
  readonly origins: Set<string>

  private home: Home
  private db: Db
  readonly port: number

  constructor(home: Home, db: Db, port: number) {
    this.home = home
    this.db = db
    this.port = port
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
    // The dashboard dev server proxies to us from its own origin.
    if (process.env.HEYBOTOS_DEV_ORIGIN) this.origins.add(process.env.HEYBOTOS_DEV_ORIGIN)
    this.rotateLogin()
    this.db.run('delete from sessions where last_seen < ?', Date.now() - SESSION_DAYS * 86_400_000)
  }

  /** A fresh single-use sign-in link, written where only this user can read it. */
  private rotateLogin(): void {
    this.loginToken = randomBytes(24).toString('hex')
    writeFileSync(join(this.home.state, 'login-url'), `${this.loginUrl()}\n`, { mode: 0o600 })
  }

  loginUrl(next = ''): string {
    // "next" is where to land after signing in: a path inside the dashboard, nothing else.
    const to = /^\/[A-Za-z0-9/_-]*$/.test(next) && next !== '/' ? `&next=${encodeURIComponent(next)}` : ''
    return `http://127.0.0.1:${this.port}/auth?t=${this.loginToken}${to}`
  }

  hostOk(host: string | undefined): boolean {
    return host !== undefined && this.hosts.has(host)
  }

  originOk(origin: string | undefined): boolean {
    return origin === undefined || this.origins.has(origin)
  }

  /** Trade the sign-in token for a session cookie value. The token stops working at once. */
  redeem(token: string): string | null {
    if (!token || !same(token, this.loginToken)) return null
    this.rotateLogin()
    const session = randomBytes(32).toString('hex')
    const now = Date.now()
    this.db.run('insert into sessions (hash, created_at, last_seen) values (?, ?, ?)', sha(session), now, now)
    return session
  }

  cookieHeader(session: string): string {
    return `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`
  }

  authorised(headers: { authorization?: string; cookie?: string }): boolean {
    const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (bearer && same(bearer, this.home.secret)) return true
    const session = headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1)
    if (!session) return false
    const hash = sha(session)
    const row = this.db.get<{ hash: string }>('select hash from sessions where hash = ?', hash)
    if (!row) return false
    this.db.run('update sessions set last_seen = ? where hash = ?', Date.now(), hash)
    return true
  }
}
