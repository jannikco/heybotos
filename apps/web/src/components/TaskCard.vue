<script setup lang="ts">
// A piece of work, as it appears in a project's conversation: who is on it, what they are doing
// right now, and how it ended. Questions are answered right here.
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { TaskView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { elapsed } from '../format'
import { staffById, state } from '../store'
import ActivityStrip from './ActivityStrip.vue'
import AgentFace from './AgentFace.vue'
import ApprovalCard from './ApprovalCard.vue'

const props = defineProps<{ task: TaskView; to: string; open?: boolean }>()

const run = computed(() => state.runs.filter((r) => r.taskId === props.task.id).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null)
const member = computed(() => staffById(props.task.assignee))
const working = computed(() => props.task.status === 'running')
const seconds = computed(() => (run.value?.startedAt ? ((run.value.endedAt ?? state.now) - run.value.startedAt) / 1000 : 0))
const requests = computed(() => state.approvals.filter((a) => a.taskId === props.task.id))
const asking = computed(() => props.task.status === 'needs_input' && !requests.value.length)

const WORD: Record<TaskView['status'], string> = { todo: 'Not started', queued: 'Waiting', running: 'Working', needs_input: 'Needs you', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Stopped' }
const tone = computed(() => ({ running: 'var(--signal)', needs_input: 'var(--wait)', blocked: 'var(--wait)', done: 'var(--ok)', failed: 'var(--bad)' })[props.task.status as string] ?? 'var(--ink-3)')
const line = computed(() => {
  const t = props.task
  if (t.status === 'running') return run.value?.activity ?? 'Starting'
  if (t.status === 'queued' || t.status === 'todo') return t.waitReason ?? (t.status === 'todo' ? 'Not started yet' : 'Waiting for a free slot')
  if (t.status === 'cancelled') return 'You stopped it'
  return t.summary ?? ''
})

const answer = ref('')
const busy = ref(false)
const problem = ref('')
async function send(): Promise<void> {
  if (!answer.value.trim()) return
  busy.value = true
  problem.value = ''
  try {
    await api(`/api/tasks/${props.task.id}/answer`, { method: 'POST', body: { text: answer.value } })
    answer.value = ''
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <article class="task" :class="{ on: open }" :style="{ '--tone': tone }" :aria-label="`Task: ${task.title}`">
    <RouterLink :to="to" class="head">
      <AgentFace :seed="task.assignee ?? task.id" :hue="member?.hue ?? 220" :size="30" :state="working ? 'working' : asking || requests.length ? 'needs' : 'idle'" />
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <span class="text-ink-2 shrink-0 text-xs font-medium">{{ member?.name ?? 'A worker' }}<template v-if="member"> · {{ member.title }}</template></span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-medium" :style="{ color: tone }">
            <span class="size-1.5 rounded-full" :class="working ? 'dot-working' : ''" :style="{ background: tone, color: tone }"></span>{{ WORD[task.status] }}
            <span v-if="run?.startedAt" class="telemetry">{{ elapsed(run, state.now) }}</span>
          </span>
        </span>
        <span class="block truncate text-lg font-medium leading-snug">{{ task.title }}</span>
      </span>
    </RouterLink>

    <p v-if="line && !asking" class="body line-clamp-3" :class="working ? 'working-text' : task.status === 'failed' ? 'text-bad' : 'text-ink-2'">{{ line }}</p>
    <div v-if="working && run" class="body mt-1.5 overflow-hidden"><ActivityStrip :ticks="state.pulse[run.id] ?? []" :seconds="seconds" live /></div>

    <div v-if="asking" class="body">
      <p class="text-wait whitespace-pre-wrap">{{ task.question }}</p>
      <form class="mt-2 flex items-end gap-2" @submit.prevent="send">
        <label :for="`a-${task.id}`" class="sr-only">Your answer to {{ member?.name ?? 'the worker' }}</label>
        <textarea :id="`a-${task.id}`" v-model="answer" rows="1" class="field min-h-[1.9rem] resize-y" placeholder="Answer, and it carries on" @keydown.enter.exact.prevent="send"></textarea>
        <button class="btn btn-primary" :disabled="busy || !answer.trim()">Send</button>
      </form>
      <p v-if="problem" class="text-bad mt-1.5 text-xs" role="alert">{{ problem }}</p>
    </div>
    <div v-if="requests.length" class="body flex flex-col gap-2">
      <ApprovalCard v-for="a in requests" :key="a.id" :approval="a" />
    </div>
  </article>
</template>

<style scoped>
@reference '../style.css';
.task {
  max-width: 34rem;
  border: 1px solid var(--line);
  border-left: 2px solid var(--tone);
  border-radius: 10px;
  background: var(--surface);
  padding: 0.55rem 0.7rem 0.6rem;
}
.task.on {
  border-color: color-mix(in srgb, var(--signal) 55%, transparent);
  border-left-color: var(--tone);
  background: var(--raised);
}
.head {
  @apply flex items-center gap-2.5;
}
.body {
  margin-left: 2.55rem;
  margin-top: 0.25rem;
}
</style>
