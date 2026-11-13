// A notification when something lands in the owner's inbox, so they do not have to watch the page.
import type { Bus } from './bus.ts'
import type { Home } from './home.ts'
import { systemNotify } from './platform.ts'

export const notify = systemNotify

/** Tell the owner about new requests and new questions. Once each: a task that keeps waiting is not repeated. */
export function watchInbox(home: Home, bus: Bus, send = notify, presence?: { desktop: number }): void {
  if (!home.config.notifications) return
  const asked = new Map<string, string>()
  const base = send
  // The desktop app shows richer, clickable notifications; while it is connected this stays quiet.
  send = (title, body) => {
    if (!presence || presence.desktop === 0) base(title, body)
  }
  bus.on('approval', (a) => {
    if (a.status === 'pending') send(a.title, `Waiting for your yes or no: ${a.summary}`)
  })
  bus.on('task', (t) => {
    const key = t.status === 'needs_input' ? `ask:${t.question}` : t.status === 'blocked' ? `blocked:${t.summary}` : ''
    if (!key) return void asked.delete(t.id)
    if (asked.get(t.id) === key) return
    asked.set(t.id, key)
    // A task waiting for an approval already produced a notification for that request.
    if (t.status === 'needs_input' && /approval/i.test(t.question ?? '')) return
    send(t.title, t.status === 'blocked' ? `Blocked: ${t.summary ?? ''}` : `Asks: ${t.question ?? ''}`)
  })
}
