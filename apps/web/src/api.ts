import { state } from './store'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
    })
  } catch {
    state.reachable = false
    throw new ApiError('The HeyBotOS service is not answering. Open the HeyBotOS app to start it.', 0)
  }
  state.reachable = true
  if (res.status === 401) {
    state.signedIn = false
    throw new ApiError('Not signed in.', 401)
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(data.error ?? `The daemon answered with an error (${res.status}).`, res.status)
  return data as T
}
