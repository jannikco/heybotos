<script setup lang="ts">
// A member of the team: what they are on right now, what they have done, and who they are
// (their role, how they work, what they have noted for themselves), all of it editable.
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { StaffView, TaskKind } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import AgentFace from '../components/AgentFace.vue'
import EnginePicker from '../components/EnginePicker.vue'
import NewTask from '../components/NewTask.vue'
import TaskCard from '../components/TaskCard.vue'
import { ago } from '../format'
import { loadStaff, state } from '../store'

const route = useRoute()
const id = computed(() => String(route.params.id))
const member = computed<StaffView | undefined>(() => state.staff.find((m) => m.id === id.value))
const tasks = computed(() => state.tasks.filter((t) => t.assignee === id.value))
const current = computed(() => tasks.value.filter((t) => ['running', 'queued', 'needs_input', 'blocked'].includes(t.status)))
const past = computed(() => tasks.value.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status)).slice(0, 30))

const KINDS: Array<[TaskKind, string]> = [['build', 'Building'], ['review', 'Reviewing'], ['research', 'Research'], ['write', 'Writing'], ['ops', 'Operations'], ['other', 'Everything else']]
const form = reactive({ name: '', title: '', focus: [] as TaskKind[], engine: 'auto', model: '', effort: '', persona: '', memory: '', active: true })
const saved = ref('')
const problem = ref('')
const creating = ref(false)

// The team list reloads whenever anything happens anywhere (a task starts, the manager answers). Such a
// reload must not wipe what is being typed here, so it only replaces the fields that still show what
// the daemon said last time.
let known: { id: string; fields: Record<string, unknown> } | null = null
watch(
  member,
  (m) => {
    if (!m) return
    const fields: Record<string, unknown> = { name: m.name, title: m.title, focus: [...m.focus], engine: m.engine, model: m.model, effort: m.effort, persona: m.persona, memory: m.memory, active: m.active }
    const before = known?.id === m.id ? known.fields : null
    const shown = form as Record<string, unknown>
    for (const k of Object.keys(fields)) if (!before || JSON.stringify(shown[k]) === JSON.stringify(before[k])) shown[k] = k === 'focus' ? [...m.focus] : fields[k]
    known = { id: m.id, fields }
    if (!before) saved.value = ''
  },
  { immediate: true },
)

async function save(): Promise<void> {
  problem.value = ''
  saved.value = ''
  try {
    await api(`/api/staff/${id.value}`, { method: 'PUT', body: { ...form } })
    // From here the form shows what was saved, as the daemon stored it.
    known = null
    await loadStaff()
    saved.value = 'Saved.'
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
</script>

<template>
  <div v-if="member" class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <AgentFace :seed="member.id" :hue="member.hue" :size="26" :state="member.currentTaskId ? 'working' : member.active ? 'idle' : 'off'" :badge="false" />
      <h1>{{ member.name }}</h1>
      <p class="text-ink-3 truncate">{{ member.title }}<template v-if="!member.active">, retired</template></p>
      <span class="flex-1"></span>
      <p class="text-ink-3 tabular hidden sm:block">{{ member.stats.done }} done<template v-if="member.stats.failed">, {{ member.stats.failed }} failed</template><template v-if="member.stats.lastActiveAt">, last active {{ ago(member.stats.lastActiveAt, state.now) }}</template></p>
      <button class="btn btn-primary" :disabled="!member.active" @click="creating = true">Give {{ member.name }} a task</button>
    </header>

    <div class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section class="min-h-0 overflow-y-auto px-5 py-5" :aria-label="`${member.name}'s work`">
        <h2 class="label">On now</h2>
        <p v-if="!current.length" class="text-ink-3 mt-2">Nothing. {{ member.name }} is free.</p>
        <div class="mt-2 flex flex-col gap-2">
          <TaskCard v-for="t in current" :key="t.id" :task="t" :to="`/t/${t.project}/${t.lastRunId ?? t.id}`" />
        </div>
        <h2 class="label mt-7">Earlier</h2>
        <p v-if="!past.length" class="text-ink-3 mt-2">No finished work yet.</p>
        <div class="mt-2 flex flex-col gap-2">
          <TaskCard v-for="t in past" :key="t.id" :task="t" :to="`/t/${t.project}/${t.lastRunId ?? t.id}`" />
        </div>
      </section>

      <form class="border-line-soft min-h-0 overflow-y-auto border-t px-5 py-5 lg:border-l lg:border-t-0" :aria-label="`Who ${member.name} is`" @submit.prevent="save">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="m-name" class="label">Name</label>
            <input id="m-name" v-model="form.name" class="field mt-1" required />
          </div>
          <div>
            <label for="m-title" class="label">Role</label>
            <input id="m-title" v-model="form.title" class="field mt-1" required />
          </div>
        </div>
        <fieldset class="mt-4">
          <legend class="label">Takes this kind of work when nobody is named</legend>
          <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <label v-for="[k, name] in KINDS" :key="k" class="flex items-center gap-1.5"><input v-model="form.focus" type="checkbox" :value="k" class="accent-signal" />{{ name }}</label>
          </div>
        </fieldset>
        <EnginePicker id="m" v-model:engine="form.engine" v-model:model="form.model" v-model:effort="form.effort" class="mt-4" auto-label="Automatic" auto-value="auto" />
        <label for="m-persona" class="label mt-4 block">How {{ member.name }} works</label>
        <textarea id="m-persona" v-model="form.persona" class="field mt-1 min-h-28 resize-y leading-relaxed" placeholder="You ..."></textarea>
        <label for="m-memory" class="label mt-4 block">{{ member.name }}'s own notes, kept from task to task</label>
        <textarea id="m-memory" v-model="form.memory" class="field mt-1 min-h-32 resize-y font-mono text-xs leading-relaxed" placeholder="Empty so far. Notes appear here as tasks finish."></textarea>
        <label class="mt-4 flex items-center gap-2"><input v-model="form.active" type="checkbox" class="accent-signal" />On the active team (gets new work)</label>
        <div class="mt-4 flex items-center gap-3">
          <button class="btn btn-primary">Save</button>
          <p v-if="saved" class="text-ok" role="status">{{ saved }}</p>
          <p v-if="problem" class="text-bad" role="alert">{{ problem }}</p>
        </div>
      </form>
    </div>
    <NewTask :open="creating" :assignee="member.id" @close="creating = false" />
  </div>
  <p v-else class="text-ink-3 p-6">Nobody on the team has that name.</p>
</template>
