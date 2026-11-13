// In-process fan-out from the supervisor to SSE clients, the scheduler and the manager.
import { EventEmitter } from 'node:events'
import type { ApprovalView, ChatMessage, LiveDelta, RunView, StoredEvent, TaskView, UpdateState } from '@heybotos/protocol'

export interface BusEvents {
  event: [StoredEvent]
  delta: [LiveDelta]
  run: [RunView]
  finished: [RunView]
  task: [TaskView]
  /** A task was deleted. */
  'task-removed': [{ id: string }]
  approval: [ApprovalView]
  identity: [{ managerName: string }]
  /** A newer version was found, is being fetched, or is ready. */
  update: [UpdateState]
  chat: [{ message: ChatMessage | null; activeRunId: string | null; activeThread: string | null; waitingReports: number }]
  limit: [{ engine: RunView['engine']; rejected: boolean; resetsAt: number | null; utilization: number | null; window?: string | null; status?: string }]
}

export class Bus extends EventEmitter<BusEvents> {
  constructor() {
    super()
    this.setMaxListeners(0)
  }
}
