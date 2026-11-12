<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TaskChanges } from '@heybotos/protocol'
import { api, ApiError } from '../api'

const props = defineProps<{ taskId: string; canUndo: boolean; refreshKey: string }>()

const changes = ref<TaskChanges | null>(null)
const problem = ref('')
const showPatch = ref(false)
const confirming = ref(false)
const busy = ref(false)
const undone = ref('')

async function load(): Promise<void> {
  problem.value = ''
  try {
    changes.value = (await api<{ changes: TaskChanges }>(`/api/tasks/${props.taskId}/changes`)).changes
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
watch(() => [props.taskId, props.refreshKey], load, { immediate: true })

const totals = computed(() => {
  const f = changes.value?.files ?? []
  return { added: f.reduce((n, x) => n + x.added, 0), removed: f.reduce((n, x) => n + x.removed, 0) }
})
const lines = computed(() => (changes.value?.patch ?? '').split('\n'))

async function undo(): Promise<void> {
  busy.value = true
  problem.value = ''
  try {
    const res = await api<{ files: number }>(`/api/tasks/${props.taskId}/undo`, { method: 'POST' })
    undone.value = `Put ${res.files} file${res.files === 1 ? '' : 's'} back to how ${res.files === 1 ? 'it was' : 'they were'} before the task.`
    confirming.value = false
    await load()
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="glass rounded-2xl px-5 py-4" aria-label="What changed in the folder">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 class="text-lg">Changes in the folder</h3>
      <p v-if="changes?.available && changes.files.length" class="tabular text-sm">
        <span class="text-ok">+{{ totals.added }}</span> <span class="text-bad">−{{ totals.removed }}</span>
        <span class="text-ink-3"> in {{ changes.files.length }} file{{ changes.files.length === 1 ? '' : 's' }}</span>
      </p>
      <button type="button" class="text-ink-3 hover:text-ink ml-auto text-sm underline underline-offset-2" @click="load">Look again</button>
    </div>

    <p v-if="problem" class="text-bad mt-2" role="alert">{{ problem }}</p>
    <p v-if="undone" class="text-ok mt-2" role="status">{{ undone }}</p>
    <p v-if="!changes && !problem" class="text-ink-3 mt-2">Comparing the folder with how it was…</p>
    <p v-else-if="changes && !changes.available" class="text-ink-2 mt-2 max-w-[60ch]">{{ changes.reason }}</p>
    <p v-else-if="changes && !changes.files.length" class="text-ink-2 mt-2">Nothing in the folder differs from before the task started.</p>

    <template v-else-if="changes">
      <ul class="mt-2.5 font-mono text-xs leading-relaxed">
        <li v-for="f in changes.files" :key="f.path" class="flex items-baseline gap-3">
          <span class="w-14 shrink-0 font-sans text-sm" :class="f.status === 'added' ? 'text-ok' : f.status === 'deleted' ? 'text-bad' : 'text-ink-3'">{{ f.status }}</span>
          <span class="min-w-0 flex-1 truncate" :title="f.path">{{ f.path }}</span>
          <span class="tabular shrink-0"><span class="text-ok">+{{ f.added }}</span> <span class="text-bad">−{{ f.removed }}</span></span>
        </li>
      </ul>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" class="btn" :aria-expanded="showPatch" @click="showPatch = !showPatch">{{ showPatch ? 'Hide the line-by-line changes' : 'Show the line-by-line changes' }}</button>
        <button v-if="canUndo && !confirming" type="button" class="btn btn-danger" @click="confirming = true">Undo these changes</button>
      </div>

      <div v-if="confirming" class="bg-bad-soft mt-3 rounded-lg px-3.5 py-3" role="alertdialog" aria-label="Confirm undo">
        <p class="max-w-[60ch]">
          This puts {{ changes.files.length === 1 ? 'this file' : `these ${changes.files.length} files` }} back to how
          {{ changes.files.length === 1 ? 'it was' : 'they were' }} before the task started, including anything you edited in them since. Your commits and other files are not touched, and the current state is kept in git so the undo can be reversed.
        </p>
        <div class="mt-2.5 flex gap-2">
          <button type="button" class="btn btn-danger" :disabled="busy" @click="undo">{{ busy ? 'Undoing' : 'Undo changes' }}</button>
          <button type="button" class="btn" @click="confirming = false">Keep them</button>
        </div>
      </div>

      <pre v-if="showPatch" class="bg-sunken mt-3 max-h-[28rem] overflow-auto rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"><template v-for="(l, i) in lines" :key="i"><span :class="l.startsWith('+') && !l.startsWith('+++') ? 'text-ok' : l.startsWith('-') && !l.startsWith('---') ? 'text-bad' : l.startsWith('@@') || l.startsWith('diff ') ? 'text-signal' : 'text-ink-2'">{{ l }}</span>{{ '\n' }}</template></pre>
      <p v-if="showPatch && changes.patchClipped" class="text-ink-3 mt-1.5 text-sm">The change is too large to show in full; this is the first part.</p>
    </template>
  </section>
</template>
