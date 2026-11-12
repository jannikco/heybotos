<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { LiveDelta, RunView, StoredEvent } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import type { TaskView } from '@heybotos/protocol'
import { clock, elapsed, STATUS_TONE, STATUS_WORDS, tokens } from '../format'
import { isLive, isWorking, state, taskById } from '../store'
import { buildTree } from '../transcript'
import ApprovalCard from './ApprovalCard.vue'
import EngineTag from './EngineTag.vue'
import StatusDot from './StatusDot.vue'
import TaskChanges from './TaskChanges.vue'
import Prose from './Prose.vue'
import TranscriptItem from './TranscriptItem.vue'

const props = withDefaults(defineProps<{ id: string; back?: string }>(), { back: '/agents' })
const router = useRouter()
const route = useRoute()

const run = ref<RunView | null>(null)
const events = ref<StoredEvent[]>([])
/** Text still being typed, per sub-agent call id ('' = the worker itself). */
const streaming = reactive<Record<string, { text: string; thinking: string }>>({})
const missing = ref(false)
const busy = ref(false)
const problem = ref('')
const followUp = ref('')
const scroller = ref<HTMLElement | null>(null)
let source: EventSource | null = null
let pinned = true

const tree = computed(() => buildTree(events.value))
const live = computed(() => (run.value ? isLive(run.value.status) : false))
const working = computed(() => (run.value ? isWorking(run.value.status) : false))
const turns = computed(() => {
  const r = run.value
  if (!r?.sessionId) return []
  return state.runs.filter((x) => x.sessionId === r.sessionId).sort((a, b) => a.turn - b.turn)
})
const isLatest = computed(() => run.value !== null && turns.value.at(-1)?.id === run.value.id)
const canFollowUp = computed(() => run.value !== null && !live.value && run.value.sessionId !== null && isLatest.value)

/** The task this agent is doing; or, when the panel was opened on a task that has not run yet, that task. */
const pendingTask = computed<TaskView | undefined>(() => (props.id.startsWith('t_') ? taskById(props.id) : undefined))
const task = computed<TaskView | undefined>(() => pendingTask.value ?? taskById(run.value?.taskId))
const requests = computed(() => state.approvals.filter((a) => (task.value ? a.taskId === task.value.id : a.runId === run.value?.id)))
const asking = computed(() => isLatest.value && task.value?.status === 'needs_input')
const blocked = computed(() => isLatest.value && task.value?.status === 'blocked')

function onScroll(): void {
  const el = scroller.value
  if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function stick(): void {
  if (!pinned) return
  void nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function open(id: string): void {
  source?.close()
  source = null
  if (id.startsWith('t_')) {
    // Opened on a task. Once it has a run, show that; until then there is nothing to stream.
    run.value = null
    events.value = []
    return
  }
  run.value = state.runs.find((r) => r.id === id) ?? null
  events.value = []
  for (const k of Object.keys(streaming)) delete streaming[k]
  missing.value = false
  pinned = true
  source = new EventSource(`/api/runs/${id}/stream`)
  source.addEventListener('run', (e) => (run.value = JSON.parse((e as MessageEvent).data) as RunView))
  source.addEventListener('ev', (e) => {
    const ev = JSON.parse((e as MessageEvent).data) as StoredEvent
    if (events.value.some((x) => x.id === ev.id)) return
    events.value.push(ev)
    // The finished block replaces whatever was being typed in the same place.
    const key = ev.parent ?? ''
    if (ev.kind === 'text' && streaming[key]) streaming[key].text = ''
    if (ev.kind === 'thinking' && streaming[key]) streaming[key].thinking = ''
    stick()
  })
  source.addEventListener('delta', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as LiveDelta
    const slot = (streaming[d.parent ?? ''] ??= { text: '', thinking: '' })
    slot[d.channel] += d.text
    stick()
  })
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) missing.value = true
  }
}

watch(() => props.id, open, { immediate: true })
watch(
  () => pendingTask.value?.lastRunId,
  (runId) => {
    if (runId) void router.replace(route.name === 'thread' ? `/t/${String(route.params.thread)}/${runId}` : `/agents/${runId}`)
  },
  { immediate: true },
)

async function taskAction(action: 'start' | 'stop'): Promise<void> {
  if (!task.value) return
  busy.value = true
  problem.value = ''
  try {
    await api(`/api/tasks/${task.value.id}/${action}`, { method: 'POST' })
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
onBeforeUnmount(() => source?.close())

// ── actions ──

async function stop(): Promise<void> {
  busy.value = true
  problem.value = ''
  try {
    await api(`/api/runs/${props.id}/stop`, { method: 'POST' })
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}

async function send(): Promise<void> {
  if (!followUp.value.trim()) return
  busy.value = true
  problem.value = ''
  try {
    const { run: next } = await api<{ run: RunView }>(`/api/runs/${props.id}/continue`, { method: 'POST', body: { prompt: followUp.value } })
    followUp.value = ''
    await router.push(route.name === 'thread' ? `/t/${String(route.params.thread)}/${next.id}` : `/agents/${next.id}`)
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <aside class="panel border-line flex h-dvh min-w-0 flex-col border-l" aria-label="Agent details">
    <div v-if="missing && !run" class="p-6">
      <h2 class="text-xl">That agent is not here any more</h2>
      <RouterLink to="/agents" class="btn mt-4">Back to all agents</RouterLink>
    </div>

    <template v-else-if="pendingTask && !run">
      <header class="border-line border-b px-5 pb-4 pt-5">
        <div class="flex items-start gap-3">
          <h2 class="min-w-0 flex-1 text-xl leading-tight">{{ pendingTask.title }}</h2>
          <RouterLink :to="back" class="btn" aria-label="Close details">Close</RouterLink>
        </div>
        <p class="text-ink-2 mt-2.5 text-sm">
          In <RouterLink :to="`/projects/${pendingTask.project}`" class="text-ink underline underline-offset-2">{{ pendingTask.projectName }}</RouterLink>
        </p>
      </header>
      <div class="flex flex-col gap-3.5 px-5 py-5">
        <p v-if="pendingTask.status === 'queued'" class="bg-sunken rounded-lg px-3.5 py-2.5">{{ pendingTask.waitReason ?? 'Waiting to start.' }}</p>
        <p v-else-if="pendingTask.status === 'todo'" class="bg-sunken rounded-lg px-3.5 py-2.5">This task has not been started.</p>
        <p v-else-if="pendingTask.status === 'cancelled'" class="bg-sunken rounded-lg px-3.5 py-2.5">This task was cancelled before it started.</p>
        <p v-else-if="pendingTask.summary" class="bg-bad-soft text-bad rounded-lg px-3.5 py-2.5" role="alert">{{ pendingTask.summary }}</p>
        <div class="bg-sunken rounded-xl px-4 py-3">
          <p class="text-ink-3 text-sm">The task</p>
          <p class="mt-1 max-w-[68ch] whitespace-pre-wrap text-lg leading-relaxed">{{ pendingTask.brief }}</p>
        </div>
        <div class="flex gap-2">
          <button v-if="pendingTask.status === 'todo' || pendingTask.status === 'cancelled' || pendingTask.status === 'failed'" class="btn btn-primary" :disabled="busy" @click="taskAction('start')">Start it now</button>
          <button v-if="pendingTask.status === 'queued' || pendingTask.status === 'todo'" class="btn btn-danger" :disabled="busy" @click="taskAction('stop')">Cancel task</button>
        </div>
        <p v-if="problem" class="text-bad text-sm" role="alert">{{ problem }}</p>
      </div>
    </template>

    <template v-else-if="run">
      <header class="border-line border-b px-5 pb-4 pt-5">
        <div class="flex items-start gap-3">
          <h2 class="min-w-0 flex-1 text-xl leading-tight">{{ run.title }}</h2>
          <button v-if="live" class="btn btn-danger" :disabled="busy || run.status === 'stopping'" @click="stop">
            {{ run.status === 'stopping' ? 'Stopping' : run.status === 'queued' ? 'Remove from queue' : 'Stop' }}
          </button>
          <RouterLink :to="back" class="btn" aria-label="Close details">Close</RouterLink>
        </div>
        <p class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span class="inline-flex items-center gap-2 font-medium" :class="{ 'text-bad': STATUS_TONE[run.status] === 'bad', 'text-wait': STATUS_TONE[run.status] === 'wait', 'text-ok': STATUS_TONE[run.status] === 'ok' }">
            <StatusDot :tone="STATUS_TONE[run.status]" :pulse="working" :label="STATUS_WORDS[run.status]" />{{ asking ? 'Needs you' : blocked ? 'Blocked' : STATUS_WORDS[run.status] }}
          </span>
          <RouterLink v-if="task" :to="`/projects/${task.project}`" class="underline underline-offset-2">{{ task.projectName }}</RouterLink>
          <EngineTag :engine="run.engine" />
          <span class="text-ink-2 tabular">{{ elapsed(run, state.now) }}</span>
          <span v-if="run.tokensOut" class="text-ink-3 tabular">{{ tokens(run.tokensOut) }} tokens written</span>
        </p>
        <p class="telemetry mt-2 truncate" :title="run.cwd">{{ run.cwd }}</p>
        <nav v-if="turns.length > 1" class="mt-3 flex flex-wrap gap-1.5" aria-label="Turns of this conversation">
          <RouterLink v-for="t in turns" :key="t.id" :to="route.name === 'thread' ? `/t/${String(route.params.thread)}/${t.id}` : `/agents/${t.id}`" class="rounded-full px-2.5 py-0.5 text-xs" :class="t.id === run.id ? 'bg-ink text-paper' : 'bg-sunken text-ink-2 hover:text-ink'">
            Turn {{ t.turn }}
          </RouterLink>
        </nav>
      </header>

      <div ref="scroller" class="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-5" @scroll.passive="onScroll">
        <div class="glass rounded-2xl px-4 py-3.5">
          <p class="telemetry">You asked, at {{ clock(run.createdAt) }}</p>
          <p class="mt-1 max-w-[68ch] whitespace-pre-wrap text-lg leading-relaxed">{{ run.prompt }}</p>
        </div>

        <p v-if="run.status === 'queued'" class="text-ink-2">
          All {{ state.me?.maxWorkers }} worker slots are busy. This one starts as soon as another finishes.
        </p>

        <TranscriptItem v-for="item in tree" :key="item.ev.id" :item="item" :live="working" :streaming="streaming" />

        <p v-if="streaming['']?.thinking && working" class="text-ink-3 text-sm">Thinking…</p>
        <Prose v-if="streaming['']?.text && working" class="caret text-lg leading-relaxed" :text="streaming[''].text" live />
        <p v-if="run.status === 'starting'" class="text-ink-3">Starting the {{ run.engine }} command-line tool…</p>

        <p v-if="run.status === 'cancelled'" class="text-ink-2">You stopped it here. Send a follow-up to pick the work back up.</p>

        <ApprovalCard v-for="a in requests" :key="a.id" :approval="a" />

        <div v-if="asking && !requests.length" class="bg-wait-soft rounded-xl px-4 py-3.5" role="status">
          <p class="text-wait text-sm font-semibold">It stopped to ask you</p>
          <p class="mt-1 max-w-[68ch] whitespace-pre-wrap text-lg leading-relaxed">{{ task?.question }}</p>
        </div>
        <div v-else-if="blocked" class="bg-wait-soft rounded-xl px-4 py-3.5" role="status">
          <p class="text-wait text-sm font-semibold">Something outside its control stopped it</p>
          <p class="mt-1 max-w-[68ch]">Read its report above. When the way is clear, tell it to go on.</p>
        </div>

        <TaskChanges v-if="task && isLatest && run.status !== 'queued'" :task-id="task.id" :can-undo="!live" :refresh-key="`${run.id}:${run.status}`" />
        <p v-if="run.error && !tree.some((i) => i.ev.kind === 'error')" class="bg-bad-soft text-bad whitespace-pre-wrap rounded-lg px-3.5 py-2.5" role="alert">{{ run.error }}</p>
      </div>

      <form v-if="canFollowUp" class="border-line border-t px-5 py-4" @submit.prevent="send">
        <label for="follow-up" class="text-ink-2 text-sm font-medium">{{ asking ? 'Your answer' : 'Send a follow-up to this agent' }}</label>
        <div class="mt-1.5 flex items-end gap-2">
          <textarea id="follow-up" v-model="followUp" rows="2" class="field min-h-[2.6rem] resize-y" :placeholder="asking ? 'It picks up where it stopped.' : 'It remembers everything above.'" @keydown.meta.enter="send" @keydown.ctrl.enter="send"></textarea>
          <button class="btn btn-primary" :disabled="busy || !followUp.trim()">Send</button>
        </div>
        <p v-if="problem" class="text-bad mt-2 text-sm" role="alert">{{ problem }}</p>
      </form>
      <p v-else-if="problem" class="text-bad border-line border-t px-5 py-3 text-sm" role="alert">{{ problem }}</p>
    </template>
  </aside>
</template>

<style scoped>
.panel {
  background: var(--surface);
}
</style>
