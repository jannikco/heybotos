<script setup lang="ts">
// What the manager is doing right now, while its turn is in progress: the steps it takes (looking
// up a project, handing out a task) and the answer as it is being written.
import { onBeforeUnmount, ref, watch } from 'vue'
import type { LiveDelta, StoredEvent } from '@heybotos/protocol'
import { managerName } from '../store'
import AgentFace from './AgentFace.vue'
import Prose from './Prose.vue'

const props = defineProps<{ runId: string }>()
const steps = ref<Array<{ id: number; label: string; failed: boolean }>>([])
const typing = ref('')
let source: EventSource | null = null

function open(id: string): void {
  source?.close()
  steps.value = []
  typing.value = ''
  source = new EventSource(`/api/runs/${id}/stream`)
  source.addEventListener('ev', (e) => {
    const ev = JSON.parse((e as MessageEvent).data) as StoredEvent
    if (ev.kind === 'tool_start' && !steps.value.some((s) => s.id === ev.id)) steps.value.push({ id: ev.id, label: String(ev.data.label), failed: false })
    else if (ev.kind === 'tool_result' && ev.data.isError === true && steps.value.length) steps.value[steps.value.length - 1]!.failed = true
    else if (ev.kind === 'text') typing.value = ''
  })
  source.addEventListener('delta', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as LiveDelta
    if (d.channel === 'text' && d.parent === null) typing.value += d.text
  })
}
watch(() => props.runId, open, { immediate: true })
onBeforeUnmount(() => source?.close())
</script>

<template>
  <div class="flex items-start gap-2.5" aria-live="polite">
    <AgentFace seed="chief" :hue="250" :size="26" chief state="working" :badge="false" class="mt-1" />
    <div class="min-w-0 flex-1">
      <ol v-if="steps.length" class="border-line mb-3 ml-1 space-y-1.5 border-l pl-4">
        <li v-for="(s, i) in steps.slice(-6)" :key="s.id" class="relative text-sm">
          <span class="absolute -left-[1.22rem] top-1.5 size-1.5 rounded-full" :class="s.failed ? 'bg-bad' : i === Math.min(steps.length, 6) - 1 ? 'bg-signal' : 'bg-ink-3'"></span>
          <span class="block truncate" :class="s.failed ? 'text-bad' : i === Math.min(steps.length, 6) - 1 ? 'text-ink' : 'text-ink-3'">{{ s.label }}</span>
        </li>
      </ol>
      <Prose v-if="typing" class="caret text-lg leading-relaxed" :text="typing" live />
      <p v-else class="working-text text-lg">{{ managerName }} is working on it</p>
    </div>
  </div>
</template>
