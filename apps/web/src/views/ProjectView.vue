<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ProjectView, TaskStatus, TaskView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import NewTask from '../components/NewTask.vue'
import { ago } from '../format'
import { state } from '../store'

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const project = ref<ProjectView | null>(null)
const worktrees = ref<ProjectView[]>([])
const problem = ref('')
const notes = ref('')
const saved = ref('')
const creating = ref(false)

async function load(): Promise<void> {
  problem.value = ''
  try {
    const res = await api<{ project: ProjectView; tasks: TaskView[]; worktrees: ProjectView[] }>(`/api/projects/${slug.value}`)
    project.value = res.project
    worktrees.value = res.worktrees
    notes.value = res.project.notes
  } catch (e) {
    project.value = null
    problem.value = (e as ApiError).message
  }
}
watch(slug, load, { immediate: true })

// Live from the overview stream, so a task started elsewhere shows up here at once.
const tasks = computed(() => state.tasks.filter((t) => t.project === slug.value))

const WORDS: Record<TaskStatus, string> = {
  todo: 'Not started',
  queued: 'Waiting',
  running: 'Working',
  needs_input: 'Needs you',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
}

async function saveNotes(): Promise<void> {
  saved.value = ''
  try {
    await api(`/api/projects/${slug.value}/notes`, { method: 'PUT', body: { notes: notes.value } })
    saved.value = 'Notes saved.'
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
</script>

<template>
  <div class="max-w-4xl px-5 pb-12 pt-7">
    <p class="text-sm"><RouterLink to="/projects" class="text-ink-2 hover:text-ink underline underline-offset-2">All projects</RouterLink></p>
    <p v-if="problem" class="bg-bad-soft text-bad mt-4 rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>

    <template v-if="project">
      <header class="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-3xl">{{ project.name }}</h1>
          <p class="text-ink-3 mt-2 truncate font-mono text-xs">{{ project.path }}</p>
        </div>
        <button class="btn btn-primary" :disabled="project.missing" @click="creating = true">New task here</button>
      </header>

      <p v-if="project.description" class="mt-4 max-w-[68ch] text-lg leading-relaxed">{{ project.description }}</p>
      <p class="text-ink-2 mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span v-if="project.stack">{{ project.stack }}</span>
        <span v-if="project.lastCommitAt">Last commit {{ ago(project.lastCommitAt, state.now) }}</span>
        <span v-if="project.dirty" class="text-wait">Uncommitted changes</span>
        <span v-if="!project.isGit && project.kind === 'code'">Not a git repository: changes cannot be shown or undone</span>
        <span v-if="project.hasInstructions">Has its own instructions for agents</span>
        <span v-if="project.missing" class="text-bad">The folder is gone</span>
      </p>

      <section class="mt-8">
        <h2 class="text-xl">Tasks</h2>
        <p v-if="!tasks.length" class="text-ink-2 mt-2">No task has been given to a worker in this project yet.</p>
        <ul v-else class="border-line mt-3 border-t">
          <li v-for="t in tasks" :key="t.id" class="border-line-soft border-b">
            <RouterLink :to="`/agents/${t.lastRunId ?? t.id}`" class="hover:bg-surface/60 -mx-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 px-2 py-2.5">
              <span class="truncate font-medium">{{ t.title }}</span>
              <span class="text-sm" :class="{ 'text-wait': t.status === 'needs_input' || t.status === 'blocked', 'text-bad': t.status === 'failed', 'text-ok': t.status === 'done', 'text-signal': t.status === 'running', 'text-ink-3': ['todo', 'queued', 'cancelled'].includes(t.status) }">{{ WORDS[t.status] }}</span>
              <span class="text-ink-2 col-span-2 truncate text-sm">{{ t.question ?? t.summary ?? t.waitReason ?? t.brief }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="mt-8">
        <h2 class="text-xl"><label for="p-notes">Notes for workers</label></h2>
        <p class="text-ink-2 mt-1.5 max-w-[62ch]">Every worker in this project reads these before it starts: where things are deployed, what must not be touched, how you like things done.</p>
        <textarea id="p-notes" v-model="notes" class="field mt-3 min-h-36 resize-y" @input="saved = ''"></textarea>
        <div class="mt-2 flex items-center gap-3">
          <button class="btn" :disabled="notes === project.notes && !saved" @click="saveNotes().then(load)">Save notes</button>
          <p v-if="saved" class="text-ok text-sm" role="status">{{ saved }}</p>
        </div>
      </section>

      <section v-if="worktrees.length" class="mt-8">
        <h2 class="text-xl">Linked worktrees</h2>
        <p class="text-ink-2 mt-1.5 max-w-[62ch]">Other folders that share this repository. Only one worker at a time works across all of them.</p>
        <ul class="mt-3 space-y-1">
          <li v-for="wt in worktrees" :key="wt.slug">
            <RouterLink :to="`/projects/${wt.slug}`" class="underline underline-offset-2">{{ wt.name }}</RouterLink>
            <span v-if="wt.dirty" class="text-wait ml-3 text-sm">Uncommitted changes</span>
          </li>
        </ul>
      </section>

      <NewTask :open="creating" :project="project.slug" @close="creating = false" />
    </template>
  </div>
</template>
