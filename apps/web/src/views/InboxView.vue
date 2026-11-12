<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { ApprovalView, TaskView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import ApprovalCard from '../components/ApprovalCard.vue'
import { ago } from '../format'
import { questions, state } from '../store'

interface Gate {
  allowedHosts: string[]
  alwaysAllowTools: string[]
  hostGrantMinutes: number
  file: string
}
const gate = ref<Gate | null>(null)
const decided = ref<ApprovalView[]>([])
const answers = reactive<Record<string, string>>({})
const problems = reactive<Record<string, string>>({})
const sending = ref('')

async function load(): Promise<void> {
  const res = await api<{ gate: Gate; decided: ApprovalView[] }>('/api/inbox')
  gate.value = res.gate
  decided.value = res.decided
}
onMounted(() => void load().catch(() => {}))

async function answer(t: TaskView): Promise<void> {
  sending.value = t.id
  problems[t.id] = ''
  try {
    await api(`/api/tasks/${t.id}/answer`, { method: 'POST', body: { text: answers[t.id] ?? '' } })
    answers[t.id] = ''
  } catch (e) {
    problems[t.id] = (e as ApiError).message
  } finally {
    sending.value = ''
  }
}
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Inbox</h1>
      <span class="flex-1"></span>
      <RouterLink to="/settings/safety" class="btn btn-ghost">What waits for a yes</RouterLink>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="max-w-3xl px-5 pb-12 pt-4">
    <p class="text-ink-2 max-w-[64ch]">
      Workers run without asking, except before they reach a server that is not on your list, deploy or publish something, or change something through a connector. Those wait here, with any question a worker could not answer itself.
    </p>

    <p v-if="!state.approvals.length && !questions.length" class="mt-8 text-lg">Nothing is waiting for you.</p>

    <div v-if="state.approvals.length" class="mt-7 flex flex-col gap-4">
      <ApprovalCard v-for="a in state.approvals" :key="a.id" :approval="a" :minutes="gate?.hostGrantMinutes" linked />
    </div>

    <section v-if="questions.length" class="mt-8">
      <h2 class="text-xl">Questions from workers</h2>
      <ul class="mt-3 flex flex-col gap-4">
        <li v-for="t in questions" :key="t.id" class="border-line bg-surface rounded-xl border px-4 py-3.5">
          <p class="text-sm font-semibold" :class="t.status === 'blocked' ? 'text-bad' : 'text-wait'">{{ t.status === 'blocked' ? 'Blocked' : 'It stopped to ask you' }}</p>
          <p class="mt-1 max-w-[64ch] whitespace-pre-wrap text-lg leading-snug">{{ t.status === 'blocked' ? t.summary : t.question }}</p>
          <p class="text-ink-2 mt-1 text-sm">
            <RouterLink :to="`/agents/${t.lastRunId ?? t.id}`" class="text-ink underline underline-offset-2">{{ t.title }}</RouterLink>
            in {{ t.projectName }}, {{ ago(t.updatedAt, state.now) }}.
          </p>
          <form class="mt-3 flex items-end gap-2" @submit.prevent="answer(t)">
            <label :for="`ans-${t.id}`" class="sr-only">Your answer</label>
            <textarea :id="`ans-${t.id}`" v-model="answers[t.id]" rows="2" class="field min-h-[2.6rem] resize-y" :placeholder="t.status === 'blocked' ? 'Tell it what changed, or what to do instead.' : 'Your answer. It picks up where it stopped.'"></textarea>
            <button class="btn btn-primary" :disabled="sending === t.id || !(answers[t.id] ?? '').trim()">Send</button>
          </form>
          <p v-if="problems[t.id]" class="text-bad mt-2 text-sm" role="alert">{{ problems[t.id] }}</p>
        </li>
      </ul>
    </section>

    <section v-if="decided.length" class="mt-10">
      <h2 class="text-xl">Decided earlier</h2>
      <ul class="border-line mt-3 border-t">
        <li v-for="a in decided" :key="a.id" class="border-line-soft grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-b py-2.5">
          <span class="truncate">{{ a.summary }}</span>
          <span class="text-sm" :class="a.status === 'approved' ? 'text-ok' : 'text-bad'">{{ a.status === 'approved' ? 'Allowed' : 'Not allowed' }}</span>
          <span class="text-ink-3 col-span-2 truncate text-sm">{{ a.title }}<template v-if="a.note">, with the note "{{ a.note }}"</template>, {{ ago(a.decidedAt, state.now) }}</span>
        </li>
      </ul>
    </section>

    <section v-if="gate" class="mt-10">
      <h2 class="text-xl">What passes without asking</h2>
      <dl class="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-ink-3">Servers</dt>
        <dd>{{ gate.allowedHosts.join(', ') }}</dd>
        <dt class="text-ink-3">Connector tools that may change things</dt>
        <dd>{{ gate.alwaysAllowTools.length ? gate.alwaysAllowTools.join(', ') : 'None. Tools that only read always pass.' }}</dd>
      </dl>
      <p class="text-ink-3 mt-3 max-w-[64ch] text-sm">Change these in <RouterLink to="/settings/safety" class="text-ink-2 underline underline-offset-2">Settings</RouterLink>. They take effect at once.</p>
    </section>
  </div>
  </div>
  </div>
</template>
