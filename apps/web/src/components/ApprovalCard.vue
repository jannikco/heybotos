<script setup lang="ts">
import { ref, useId } from 'vue'
import { RouterLink } from 'vue-router'
import type { ApprovalView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { ago } from '../format'
import { state } from '../store'

const props = defineProps<{ approval: ApprovalView; minutes?: number; linked?: boolean }>()
const note = ref('')
// The same request can be on the page twice (on the task's card and in the drawer beside it).
const noteId = useId()
const busy = ref(false)
const problem = ref('')

async function decide(verb: 'approve' | 'deny', always = false): Promise<void> {
  busy.value = true
  problem.value = ''
  try {
    await api(`/api/approvals/${props.approval.id}/${verb}`, { method: 'POST', body: { note: note.value, always } })
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <article class="approval rounded-3xl px-5 py-4" :aria-label="`Request: ${approval.summary}`">
    <p class="text-wait text-sm font-semibold">Waiting for your yes or no</p>
    <h3 class="mt-1 text-lg leading-snug">{{ approval.summary }}</h3>
    <p class="text-ink-2 mt-1 text-sm">
      Asked by
      <RouterLink v-if="linked" :to="`/agents/${approval.runId}`" class="text-ink underline underline-offset-2">{{ approval.title }}</RouterLink>
      <template v-else>{{ approval.title }}</template>
      <template v-if="approval.projectName"> in {{ approval.projectName }}</template>, {{ ago(approval.createdAt, state.now) }}.
    </p>
    <pre class="bg-sunken mt-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-xs leading-relaxed">{{ approval.detail }}</pre>
    <label :for="noteId" class="text-ink-2 mt-3 block text-sm">A note for the worker, if you like</label>
    <input :id="noteId" v-model="note" class="field mt-1" placeholder="For example: use staging instead" />
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn btn-primary" :disabled="busy" @click="decide('approve')">
        {{ approval.kind === 'host' ? `Allow for ${minutes ?? 15} minutes` : 'Allow once' }}
      </button>
      <button v-if="approval.kind === 'host'" class="btn" :disabled="busy" @click="decide('approve', true)">Always allow this server</button>
      <button class="btn btn-danger" :disabled="busy" @click="decide('deny')">Don't allow</button>
    </div>
    <p v-if="problem" class="text-bad mt-2 text-sm" role="alert">{{ problem }}</p>
  </article>
</template>

<style scoped>
.approval {
  background:
    radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--wait) 14%, transparent), transparent 60%),
    var(--glass);
  border: 1px solid color-mix(in srgb, var(--wait) 42%, transparent);
  box-shadow: 0 0 50px -22px var(--wait);
  backdrop-filter: blur(18px);
}
</style>
