<script setup lang="ts">
// One conversation: the general one with the manager, or a project's. In a project's conversation
// the work happens in the open: every task the team takes on appears between the messages, live.
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { ChatMessage, TaskView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import AgentFace from '../components/AgentFace.vue'
import ManagerLive from '../components/ManagerLive.vue'
import NewTask from '../components/NewTask.vue'
import Prose from '../components/Prose.vue'
import RunPanel from '../components/RunPanel.vue'
import TaskCard from '../components/TaskCard.vue'
import FileChips from '../components/task/FileChips.vue'
import { clock, dayLabel } from '../format'
import { hueOf, loadTalk, managerName, markRead, staffById, state } from '../store'
import { useUploads } from '../tracker'

const route = useRoute()
const router = useRouter()
const thread = computed(() => String(route.params.thread || 'chief'))
const opened = computed(() => (typeof route.params.open === 'string' && route.params.open ? route.params.open : null))
const isChief = computed(() => thread.value === 'chief')
const project = computed(() => state.projects.find((p) => p.slug === thread.value))
const info = computed(() => state.threads.find((t) => t.id === thread.value))
const name = computed(() => (isChief.value ? managerName.value : (project.value?.name ?? info.value?.name ?? thread.value)))
const hue = computed(() => (isChief.value ? 250 : hueOf(thread.value)))

const draft = ref('')
const sending = ref(false)
const problem = ref('')
const scroller = ref<HTMLElement | null>(null)
const box = ref<HTMLTextAreaElement | null>(null)
const creating = ref(false)

// Files that go with the message being written: picked, pasted (a screenshot) or dropped anywhere on
// the conversation. They are uploaded at once and sent by id with the message.
const { files: attached, waiting, busy: uploading, problem: uploadProblem, ids: attachedIds, add: attach, remove: detach, clear: clearAttached, onPaste, onDrop } = useUploads()
const picker = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
let dragDepth = 0
const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
function dragEnter(e: DragEvent): void {
  if (!carriesFiles(e)) return
  dragDepth++
  dragging.value = true
}
function dragOver(e: DragEvent): void {
  if (carriesFiles(e)) e.preventDefault()
}
function dragLeave(e: DragEvent): void {
  if (!carriesFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function drop(e: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  onDrop(e)
  box.value?.focus()
}
function picked(): void {
  const el = picker.value
  if (el?.files?.length) void attach([...el.files])
  if (el) el.value = ''
  box.value?.focus()
}
const canSend = computed(() => !sending.value && !uploading.value && (draft.value.trim() !== '' || attached.value.length > 0))

type Entry = { key: string; at: number; message?: ChatMessage; task?: TaskView }
const entries = computed<Entry[]>(() => {
  const out: Entry[] = (state.talk[thread.value] ?? []).map((m) => ({ key: `m${m.id}`, at: m.createdAt, message: m }))
  if (!isChief.value) for (const t of state.tasks) if (t.project === thread.value) out.push({ key: t.id, at: t.createdAt, task: t })
  return out.sort((a, b) => a.at - b.at)
})
const days = computed(() => {
  const out: Array<{ day: string; entries: Entry[] }> = []
  for (const e of entries.value) {
    const day = dayLabel(e.at, state.now)
    if (out.at(-1)?.day !== day) out.push({ day, entries: [] })
    out.at(-1)!.entries.push(e)
  }
  return out
})
const busyHere = computed(() => state.chat.activeRunId !== null && state.chat.activeThread === thread.value)
const workers = computed(() => (info.value?.workers ?? []).map((id) => staffById(id)).filter((m) => m !== undefined))
const empty = computed(() => state.talk[thread.value] !== undefined && !entries.value.length && !busyHere.value)

function toEnd(): void {
  void nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}
watch(
  thread,
  async (t) => {
    problem.value = ''
    await loadTalk(t).catch((e) => (problem.value = (e as ApiError).message))
    void markRead(t)
    toEnd()
    box.value?.focus()
  },
  { immediate: true },
)
watch(
  () => [entries.value.length, busyHere.value],
  () => {
    toEnd()
    void markRead(thread.value)
  },
)
watch(
  () => state.command.n,
  () => {
    if (state.command.name === 'new-task') creating.value = true
    if (state.command.name === 'focus') box.value?.focus()
  },
)

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!canSend.value) return
  sending.value = true
  problem.value = ''
  try {
    await api('/api/chat', { method: 'POST', body: { text, thread: thread.value, files: attachedIds.value } })
    draft.value = ''
    clearAttached()
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    sending.value = false
  }
}
const stop = () => api('/api/chat/stop', { method: 'POST' }).catch(() => {})
const openTask = (t: TaskView) => `/t/${thread.value}/${t.lastRunId ?? t.id}`
</script>

<template>
  <div class="flex h-dvh min-w-0">
    <section class="relative flex min-w-0 flex-1 flex-col" :aria-label="`Conversation with ${name}`" :style="{ '--hue': hue }" @dragenter="dragEnter" @dragover="dragOver" @dragleave="dragLeave" @drop="drop">
      <header class="viewbar">
        <RouterLink to="/list" class="btn btn-ghost md:hidden" aria-label="All conversations">‹</RouterLink>
        <AgentFace :seed="thread" :hue="hue" :size="26" :chief="isChief" :state="busyHere || info?.working ? 'working' : info?.needsYou ? 'needs' : 'idle'" :badge="false" />
        <h1 class="truncate">{{ name }}</h1>
        <p v-if="isChief" class="text-ink-3 hidden truncate sm:block">Leads the team, across every project</p>
        <p v-else-if="workers.length" class="flex min-w-0 items-center gap-1.5 truncate">
          <AgentFace v-for="m in workers" :key="m.id" :seed="m.id" :hue="m.hue" :size="18" state="working" :badge="false" />
          <span class="working-text truncate">{{ workers.map((m) => m.name).join(', ') }} working</span>
        </p>
        <p v-else-if="project" class="text-ink-3 hidden truncate sm:block">{{ project.stack || (project.kind === 'other' ? 'Not code' : '') }}</p>
        <span class="flex-1"></span>
        <RouterLink v-if="project" :to="`/projects/${project.slug}`" class="btn btn-ghost">Project</RouterLink>
        <button v-if="!isChief" class="btn" @click="creating = true">New task <span class="kbd">C</span></button>
      </header>

      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div class="mx-auto flex max-w-3xl flex-col gap-1">
          <div v-if="empty" class="py-10 text-center">
            <AgentFace :seed="thread" :hue="hue" :size="72" :chief="isChief" :badge="false" />
            <h2 class="mt-4 text-2xl">{{ isChief ? `Talk to ${name}` : name }}</h2>
            <p class="text-ink-2 mx-auto mt-2 max-w-[46ch] text-lg leading-relaxed">
              <template v-if="isChief">Say what you want done, in any project. It splits the work up, hands it to the team, and comes back with the result. Each project gets its own conversation on the left.</template>
              <template v-else>Nothing has happened here yet. Say what you want done in {{ name }}, or give the team a task directly.</template>
            </p>
          </div>

          <template v-for="d in days" :key="d.day">
            <p class="telemetry my-3 text-center">{{ d.day }}</p>
            <template v-for="e in d.entries" :key="e.key">
              <TaskCard v-if="e.task" :task="e.task" :to="openTask(e.task)" :open="opened !== null && (opened === e.task.lastRunId || opened === e.task.id)" class="my-1.5 ml-9" />
              <article v-else-if="e.message!.role === 'user'" class="my-1.5 flex flex-col items-end gap-1.5" aria-label="You said">
                <div v-if="e.message!.files.length" class="max-w-[min(40rem,86%)]"><FileChips :files="e.message!.files" end /></div>
                <div v-if="e.message!.text" class="mine max-w-[min(40rem,86%)] rounded-2xl rounded-br-md px-3.5 py-2">
                  <p class="whitespace-pre-wrap text-lg leading-relaxed">{{ e.message!.text }}</p>
                </div>
              </article>
              <article v-else-if="e.message!.role === 'manager'" class="my-1.5 flex items-start gap-2.5" :aria-label="`${managerName} said`">
                <AgentFace seed="chief" :hue="250" :size="26" chief :badge="false" class="mt-1" />
                <div class="theirs min-w-0 max-w-[min(44rem,92%)] rounded-2xl rounded-tl-md px-3.5 py-2.5">
                  <Prose :text="e.message!.text" />
                  <div v-if="e.message!.files.length" class="mt-2"><FileChips :files="e.message!.files" small /></div>
                  <p class="telemetry mt-1">{{ clock(e.message!.createdAt) }}</p>
                </div>
              </article>
              <p v-else class="bg-wait-soft text-wait my-1.5 ml-9 w-fit max-w-[40rem] whitespace-pre-wrap rounded-lg px-3 py-1.5" role="status">{{ e.message!.text }}</p>
            </template>
          </template>

          <ManagerLive v-if="busyHere" :run-id="state.chat.activeRunId!" class="my-2" />
          <p v-if="state.chat.waitingReports && !state.chat.activeRunId && isChief" class="telemetry ml-9 mt-2">{{ state.chat.waitingReports }} report{{ state.chat.waitingReports === 1 ? '' : 's' }} from the team held for the next turn</p>
        </div>
      </div>

      <form class="px-4 pb-4 sm:px-6" @submit.prevent="send">
        <div class="composer mx-auto max-w-3xl rounded-2xl" :class="{ lit: dragging }">
          <div v-if="attached.length || waiting.length" class="flex flex-wrap items-center gap-2 px-3 pt-3">
            <FileChips :files="attached" removable small @remove="detach" />
            <p v-for="w in waiting" :key="w.key" class="uploading" role="status"><span class="truncate">Uploading {{ w.name }}</span></p>
          </div>
          <div class="flex items-end gap-1 p-1.5">
            <input ref="picker" type="file" multiple class="sr-only" tabindex="-1" aria-hidden="true" @change="picked" />
            <button type="button" class="attach" aria-label="Attach files" title="Attach files. You can also drop them here or paste a screenshot." @click="picker?.click()">
              <svg viewBox="0 0 20 20" class="size-[1.15rem]" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16.5 9.6-6.2 6.2a4 4 0 0 1-5.7-5.7l6.6-6.6a2.7 2.7 0 0 1 3.8 3.8l-6.5 6.5a1.35 1.35 0 0 1-1.9-1.9l5.9-5.9" /></svg>
            </button>
            <label for="say" class="sr-only">Message to the manager</label>
            <textarea id="say" ref="box" v-model="draft" rows="1" class="placeholder:text-ink-3 block max-h-52 min-h-[2.1rem] flex-1 resize-none bg-transparent py-1.5 pl-1 text-lg leading-relaxed outline-none" :placeholder="`Message ${name}`" @keydown.enter.exact.prevent="send" @paste="onPaste"></textarea>
            <button v-if="busyHere" type="button" class="btn btn-danger" @click="stop">Stop</button>
            <button class="send" :disabled="!canSend" aria-label="Send">
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
            </button>
          </div>
        </div>
        <p v-if="problem || uploadProblem" class="text-bad mx-auto mt-1.5 max-w-3xl text-xs" role="alert">{{ problem || uploadProblem }}</p>
      </form>

      <div v-if="dragging" class="dropzone" aria-hidden="true">
        <div class="dropcard">
          <svg viewBox="0 0 20 20" class="size-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16.5 9.6-6.2 6.2a4 4 0 0 1-5.7-5.7l6.6-6.6a2.7 2.7 0 0 1 3.8 3.8l-6.5 6.5a1.35 1.35 0 0 1-1.9-1.9l5.9-5.9" /></svg>
          <p class="text-xl font-semibold">Drop to attach</p>
          <p class="text-ink-2">{{ name }} gets the files with your next message.</p>
        </div>
      </div>
    </section>

    <RunPanel v-if="opened" :id="opened" :back="`/t/${thread}`" class="w-[min(34rem,46%)] shrink-0 max-lg:fixed max-lg:inset-0 max-lg:z-20 max-lg:w-full" />
    <NewTask :open="creating" :project="isChief ? undefined : thread" @close="creating = false" @created="(id) => router.push(`/t/${thread}/${id}`)" />
  </div>
</template>

<style scoped>
.mine {
  background: var(--brand-action);
  color: #fff;
}
.theirs {
  background: var(--bubble);
}
.composer {
  background: var(--raised);
  border: 1px solid var(--line);
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.composer:focus-within {
  border-color: color-mix(in srgb, var(--signal) 70%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 18%, transparent);
}
/* The field grows with what is written in it, up to its largest height, then scrolls. */
.composer textarea {
  field-sizing: content;
}
.composer.lit {
  border-color: transparent;
  box-shadow:
    0 0 0 2px #7a55f6,
    0 0 28px color-mix(in srgb, #bb58e7 45%, transparent);
}
.attach {
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 999px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.attach:hover {
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  color: var(--ink);
}
.uploading {
  display: flex;
  align-items: center;
  max-width: 15rem;
  height: 3.25rem;
  padding: 0 0.9rem;
  border-radius: 8px;
  border: 1px dashed var(--line);
  color: var(--ink-2);
  font-size: 0.875rem;
  background: linear-gradient(100deg, transparent 30%, color-mix(in srgb, #8156f7 22%, transparent) 50%, transparent 70%) 0 0 / 250% 100%;
  animation: upload-sweep 1.3s linear infinite;
}
@keyframes upload-sweep {
  from {
    background-position: 125% 0;
  }
  to {
    background-position: -125% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .uploading {
    animation: none;
  }
}
/* Shown while files are dragged over the conversation. It takes no pointer events, so the drop lands on the conversation itself. */
.dropzone {
  position: absolute;
  inset: 2.75rem 0 0 0;
  z-index: 10;
  display: grid;
  place-items: center;
  padding: 1rem;
  pointer-events: none;
  background: color-mix(in srgb, var(--paper) 72%, transparent);
  backdrop-filter: blur(3px);
}
.dropcard {
  display: grid;
  justify-items: center;
  gap: 0.35rem;
  width: min(26rem, 100%);
  padding: 2rem 1.5rem;
  border-radius: 1.25rem;
  text-align: center;
  color: var(--ink);
  border: 2px solid transparent;
  background:
    linear-gradient(var(--raised), var(--raised)) padding-box,
    var(--brand) border-box;
  box-shadow: 0 18px 60px color-mix(in srgb, #8156f7 35%, transparent);
}
.send {
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 999px;
  background: var(--brand-action);
  color: #fff;
  flex-shrink: 0;
}
.send:disabled {
  background: var(--sunken);
  color: var(--ink-3);
}
</style>
