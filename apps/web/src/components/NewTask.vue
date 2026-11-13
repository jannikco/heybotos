<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { TaskKind, TaskView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { loadProjects, state } from '../store'
import EnginePicker from './EnginePicker.vue'

const props = defineProps<{ open: boolean; project?: string; assignee?: string }>()
const emit = defineEmits<{ close: []; created: [id: string] }>()
const router = useRouter()
// Several of these dialogs can be on one page (the app's own, and the one of the view that is open),
// so each needs ids of its own for its labels to find their fields.
const uid = useId()

const dialog = ref<HTMLDialogElement | null>(null)
const projectName = ref('')
const brief = ref('')
const kind = ref<TaskKind>('build')
const separate = ref(false)
const engine = ref<string>('')
const assignee = ref('')
const model = ref('')
const effort = ref('')
const available = ref<string[]>([])
/** Connectors the owner trusts: a worker that has only these keeps its shell. */
const trusted = ref<string[]>([])
const connectors = ref<string[]>([])
const problem = ref('')
const busy = ref(false)

const KINDS: Array<[TaskKind, string]> = [
  ['build', 'Build or fix something'],
  ['review', 'Review work, change nothing'],
  ['research', 'Research and report back'],
  ['write', 'Write or edit text'],
  ['ops', 'Run or operate something'],
  ['other', 'Something else'],
]

const choices = computed(() => state.projects.filter((p) => !p.missing))
const picked = computed(() => choices.value.find((p) => p.name.toLowerCase() === projectName.value.trim().toLowerCase() || p.slug === projectName.value.trim()))

watch(
  () => props.open,
  (open) => {
    if (!open) return dialog.value?.close()
    problem.value = ''
    assignee.value = props.assignee ?? ''
    if (props.project) projectName.value = state.projects.find((p) => p.slug === props.project)?.name ?? props.project
    if (!state.projectsLoaded) void loadProjects().catch(() => {})
    void api<{ connectors: string[]; list: Array<{ name: string; enabled: boolean; trusted: boolean }> }>('/api/connectors')
      .then((r) => {
        available.value = r.connectors
        trusted.value = r.list.filter((c) => c.enabled && c.trusted).map((c) => c.name)
        usual()
      })
      .catch(() => {})
    dialog.value?.showModal()
  },
)
/** Tick the connectors the project always gets. */
function usual(): void {
  connectors.value = (picked.value?.connectors ?? []).filter((c) => available.value.includes(c))
}
watch(picked, (p) => {
  if (!p?.isGit) separate.value = false
  usual()
})
/** With a connector that is not trusted, the worker reads other people's text and gets no shell. */
const noShell = computed(() => connectors.value.some((c) => !trusted.value.includes(c)))

async function start(): Promise<void> {
  if (!picked.value) {
    problem.value = projectName.value.trim() ? `There is no project called "${projectName.value.trim()}". Pick one from the list.` : 'Pick a project.'
    return
  }
  busy.value = true
  problem.value = ''
  try {
    const { task } = await api<{ task: TaskView }>('/api/tasks', {
      method: 'POST',
      body: { project: picked.value.slug, brief: brief.value, kind: kind.value, engine: engine.value || undefined, model: model.value || undefined, effort: effort.value || undefined, assignee: assignee.value || undefined, isolation: separate.value ? 'worktree' : 'direct', connectors: connectors.value },
    })
    brief.value = ''
    emit('close')
    // Land in the project's conversation, with the new task open beside it.
    await router.push(`/t/${task.project}/${task.lastRunId ?? task.id}`)
    emit('created', task.lastRunId ?? task.id)
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialog" class="bg-surface text-ink shadow-panel backdrop:bg-ink/40 m-auto w-[min(38rem,calc(100vw-2rem))] rounded-2xl p-0" :aria-labelledby="`${uid}-title`" @close="emit('close')">
    <form class="p-6" @submit.prevent="start">
      <h2 :id="`${uid}-title`" class="text-2xl">Give a worker a task</h2>
      <p class="text-ink-2 mt-1.5 max-w-[56ch]">It works in the project folder without asking before it edits files or runs commands. HeyBotOS records the folder first, so you can see and undo what changed.</p>

      <label :for="`${uid}-project`" class="mt-5 block text-sm font-medium">Project</label>
      <input :id="`${uid}-project`" v-model="projectName" class="field mt-1.5" :list="`${uid}-projects`" placeholder="Start typing a project name" required autocomplete="off" spellcheck="false" />
      <datalist :id="`${uid}-projects`">
        <option v-for="p in choices" :key="p.slug" :value="p.name">{{ p.stack }}</option>
      </datalist>
      <p v-if="picked" class="text-ink-3 mt-1.5 truncate font-mono text-xs">{{ picked.path }}</p>
      <p v-if="picked?.dirty && !separate" class="text-wait mt-1.5 text-sm">This folder has uncommitted changes. They are recorded first and stay as they are.</p>

      <label :for="`${uid}-brief`" class="mt-4 block text-sm font-medium">What should it achieve?</label>
      <textarea :id="`${uid}-brief`" v-model="brief" class="field mt-1.5 min-h-32 resize-y" placeholder="Describe the outcome you want and how to check it." required @keydown.meta.enter="start" @keydown.ctrl.enter="start"></textarea>

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label :for="`${uid}-kind`" class="block text-sm font-medium">Kind of work</label>
          <select :id="`${uid}-kind`" v-model="kind" class="field mt-1.5">
            <option v-for="[value, label] in KINDS" :key="value" :value="value">{{ label }}</option>
          </select>
        </div>
        <div>
          <label :for="`${uid}-who`" class="block text-sm font-medium">Who does it</label>
          <select :id="`${uid}-who`" v-model="assignee" class="field mt-1.5">
            <option value="">Whoever takes this kind of work</option>
            <option v-for="m in state.staff.filter((x) => !x.isChief && x.active)" :key="m.id" :value="m.id">{{ m.name }}, {{ m.title }}</option>
          </select>
        </div>
      </div>
      <EnginePicker :id="uid" v-model:engine="engine" v-model:model="model" v-model:effort="effort" class="mt-4" auto-label="Automatic: whoever has room" />

      <label v-if="picked?.isGit" class="mt-4 flex items-start gap-2.5">
        <input v-model="separate" type="checkbox" class="accent-signal mt-1 size-4" />
        <span>
          <span class="font-medium">Work in a separate copy</span>
          <span class="text-ink-2 block text-sm">Its own branch and folder, so it can run next to other work in this repository. Starts from the last commit, without your uncommitted changes.</span>
        </span>
      </label>

      <fieldset v-if="available.length" class="mt-4">
        <legend class="text-sm font-medium">Connectors it may use</legend>
        <p class="text-ink-2 mt-0.5 text-sm">{{ picked?.connectors?.length ? 'The ones this project always gets are ticked.' : 'None unless you tick one.' }} They work on every engine.</p>
        <div class="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
          <label v-for="c in available" :key="c" class="flex items-center gap-2">
            <input v-model="connectors" type="checkbox" :value="c" class="accent-signal size-4" />
            {{ c }}
          </label>
        </div>
        <p v-if="noShell" class="text-wait mt-2 text-sm" role="status">With {{ connectors.filter((c) => !trusted.includes(c)).join(', ') }} this worker cannot run commands or tests: what such a connector returns may be written by other people. Mark a connector as trusted in Settings, under Connectors, if it is a tool or a system of your own.</p>
      </fieldset>

      <p v-if="problem" class="bg-bad-soft text-bad mt-4 rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>

      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !brief.trim() || !projectName.trim()">{{ busy ? 'Starting' : 'Start task' }}</button>
      </div>
    </form>
  </dialog>
</template>
