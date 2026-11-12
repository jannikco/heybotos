// Turns the flat event list of a run into the tree the transcript draws: tool calls paired with
// their results, and everything a sub-agent did nested under the call that started it.
import type { StoredEvent } from '@heybotos/protocol'

export interface Item {
  ev: StoredEvent
  /** For a tool call: its result, once it has come back. */
  result?: StoredEvent
  /** For a hand-off: what the sub-agent did. */
  children: Item[]
}

export function buildTree(events: StoredEvent[]): Item[] {
  const top: Item[] = []
  const calls = new Map<string, Item>()
  let lastLimit = ''
  for (const ev of events) {
    if (ev.kind === 'usage') continue
    if (ev.kind === 'phase' && ev.data.phase !== 'init' && ev.data.phase !== 'retry' && ev.data.phase !== 'compacted') continue
    if (ev.kind === 'subagent' && ev.data.event !== 'prompt') continue
    if (ev.kind === 'limit') {
      // "allowed" is the normal state; only say something when it changes for the worse.
      const key = `${ev.data.status}:${ev.data.window}`
      if (ev.data.status === 'allowed' || key === lastLimit) continue
      lastLimit = key
    }
    if (ev.kind === 'tool_result') {
      const call = calls.get(String(ev.data.id))
      if (call) {
        call.result = ev
        continue
      }
    }
    const item: Item = { ev, children: [] }
    if (ev.kind === 'tool_start') calls.set(String(ev.data.id), item)
    const home = ev.parent ? calls.get(ev.parent)?.children : undefined
    ;(home ?? top).push(item)
  }
  return top
}
