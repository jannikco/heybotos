// Signing in to a connector through the browser (OAuth, the way MCP servers ask for it). HeyBotOS does
// this itself, as its own client, and keeps the tokens in its own database: it never borrows a login
// that one of the CLIs holds.
import { createHash, randomBytes } from 'node:crypto'

export interface OAuthServer {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  scopes: string[]
  /** The connector's own address, which the tokens are asked for. */
  resource: string
}

/** What is kept per connector once signed in. */
export interface OAuthTokens {
  clientId: string
  clientSecret: string | null
  tokenEndpoint: string
  resource: string
  access: string
  refresh: string | null
  /** Epoch ms, or null when the server did not say. */
  expiresAt: number | null
}

const b64 = (b: Buffer) => b.toString('base64url')

async function json(url: string, init?: RequestInit): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return body !== null && typeof body === 'object' ? (body as Record<string, any>) : null
  } catch {
    return null
  }
}

/** Find out where a connector wants its sign-in done. */
export async function discover(mcpUrl: string): Promise<OAuthServer> {
  const url = new URL(mcpUrl)
  const path = url.pathname.replace(/\/$/, '')
  // The connector says where to look when it turns away a request without a sign-in.
  let hinted: string | null = null
  try {
    const probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'heybotos', version: '1' } } }),
      signal: AbortSignal.timeout(20_000),
    })
    hinted = probe.headers.get('www-authenticate')?.match(/resource_metadata="?([^",\s]+)"?/i)?.[1] ?? null
    await probe.body?.cancel().catch(() => {})
  } catch {
    throw new Error('Nothing answers at that address, so there is nowhere to sign in.')
  }
  let resource: Record<string, any> | null = null
  for (const candidate of [hinted, `${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`]) {
    if (candidate && (resource = await json(candidate))) break
  }
  const issuer = new URL(typeof resource?.authorization_servers?.[0] === 'string' ? resource.authorization_servers[0] : url.origin)
  const issuerPath = issuer.pathname.replace(/\/$/, '')
  let meta: Record<string, any> | null = null
  for (const candidate of [`${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`]) {
    meta = await json(candidate)
    if (meta?.authorization_endpoint && meta?.token_endpoint) break
    meta = null
  }
  if (!meta && !resource) throw new Error('This connector does not offer a sign-in through the browser. Give it a sign-in header instead.')
  return {
    authorizationEndpoint: String(meta?.authorization_endpoint ?? `${issuer.origin}/authorize`),
    tokenEndpoint: String(meta?.token_endpoint ?? `${issuer.origin}/token`),
    registrationEndpoint: meta ? (typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : null) : `${issuer.origin}/register`,
    scopes: Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.map(String) : Array.isArray(meta?.scopes_supported) ? meta.scopes_supported.map(String) : [],
    resource: typeof resource?.resource === 'string' ? resource.resource : mcpUrl,
  }
}

/** Introduce HeyBotOS to the connector's sign-in server as a client of its own. */
export async function register(server: OAuthServer, redirectUri: string): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!server.registrationEndpoint) throw new Error('This connector only lets known apps sign in, and has no way for HeyBotOS to introduce itself. Give it a sign-in header instead.')
  const body = await json(server.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'HeyBotOS', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(server.scopes.length ? { scope: server.scopes.join(' ') } : {}) }),
  })
  if (typeof body?.client_id !== 'string') throw new Error('The connector did not accept HeyBotOS as an app that may sign in.')
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null }
}

export function newVerifier(): { verifier: string; challenge: string; state: string } {
  const verifier = b64(randomBytes(32))
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()), state: b64(randomBytes(24)) }
}

/** The page the owner signs in on. */
export function authorizeUrl(server: OAuthServer, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(server.authorizationEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('resource', server.resource)
  if (server.scopes.length) u.searchParams.set('scope', server.scopes.join(' '))
  return u.toString()
}

async function token(endpoint: string, fields: Record<string, string>, clientSecret: string | null): Promise<Record<string, any>> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...fields, ...(clientSecret ? { client_secret: clientSecret } : {}) }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => null)) as Record<string, any> | null
  if (!res.ok || typeof body?.access_token !== 'string') throw new Error(typeof body?.error_description === 'string' ? body.error_description : typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
  return body
}

const until = (body: Record<string, any>) => (typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null)

/** Swap the code the browser came back with for tokens. */
export async function exchange(server: OAuthServer, client: { clientId: string; clientSecret: string | null }, redirectUri: string, code: string, verifier: string): Promise<OAuthTokens> {
  const body = await token(server.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.clientId, code_verifier: verifier, resource: server.resource }, client.clientSecret)
  return { clientId: client.clientId, clientSecret: client.clientSecret, tokenEndpoint: server.tokenEndpoint, resource: server.resource, access: body.access_token, refresh: typeof body.refresh_token === 'string' ? body.refresh_token : null, expiresAt: until(body) }
}

/** A fresh access token from the one that renews it. Throws when the sign-in has run out for good. */
export async function renew(t: OAuthTokens): Promise<OAuthTokens> {
  if (!t.refresh) throw new Error('The sign-in has run out.')
  const body = await token(t.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId, resource: t.resource }, t.clientSecret)
  return { ...t, access: body.access_token, refresh: typeof body.refresh_token === 'string' ? body.refresh_token : t.refresh, expiresAt: until(body) }
}
