<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { TaskStatus, TaskView } from '@heybotos/protocol'
import NewTask from '../components/NewTask.vue'
import { state } from '../store'

const creating = ref(false)
const project = ref('')

const COLUMNS: Array<{ title: string; hint: string; statuses: TaskStatus[]; tone: string }> = [
  { title: 'Needs you', hint: 'Stopped to ask, or blocked', statuses: ['needs_input', 'blocked'], tone: 'text-wait' },
  { title: 'Working', hint: 'A worker is on it', statuses: ['running'], tone: 'text-signal' },
  { title: 'Waiting', hint: 'For another task, a free worker, or a start', statuses: ['queued', 'todo'], tone: 'text-ink-2' },
  { title: 'Finished', hint: 'The latest thirty', statuses: ['done', 'failed', 'cancelled'], tone: 'text-ink-2' },
]

const projects = computed(() => [...new Map(state.tasks.map((t) => [t.project, t.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1])))
const shown = computed(() => state.tasks.filter((t) => !project.value || t.project === project.value))
const byId = computed(() => new Map(state.tasks.map((t) => [t.id, t])))

function column(statuses: TaskStatus[]): TaskView[] {
  const list = shown.value.filter((t) => statuses.includes(t.status))
  return statuses.includes('done') ? list.slice(0, 30) : list
}

/** Why a card is where it is, in one line. */
function line(t: TaskView): string {
  if (t.status === 'needs_input') return t.question ?? 'Waiting for your answer'
  if (t.status === 'queued' || t.status === 'todo') return t.waitReason ?? (t.status === 'todo' ? 'Not started' : 'Waiting for a free worker slot')
  if (t.status === 'cancelled') return 'Stopped'
  return t.summary ?? ''
}
const after = (t: TaskView) => t.dependsOn.map((d) => byId.value.get(d)?.title).filter(Boolean) as string[]
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Board</h1>
      <span class="telemetry hidden sm:inline">Every task, by where it stands.</span>
      <span class="flex-1"></span>
      <label for="b-project" class="sr-only">Show tasks for</label>
      <select id="b-project" v-model="project" class="field w-auto min-w-40">
        <option value="">All projects</option>
        <option v-for="[slug, name] in projects" :key="slug" :value="slug">{{ name }}</option>
      </select>
      <button class="btn btn-primary" @click="creating = true">New task</button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="px-5 pb-12 pt-1">

    <p v-if="!state.tasks.length" class="mt-8 max-w-[52ch] text-lg">No tasks yet. Ask the manager for something, or give a worker a task yourself.</p>

    <div v-else class="mt-6 grid gap-x-5 gap-y-8 md:grid-cols-2 xl:grid-cols-4">
      <section v-for="c in COLUMNS" :key="c.title" :aria-label="c.title" class="min-w-0">
        <h2 class="border-line flex items-baseline gap-2 border-b pb-2 font-sans text-base font-semibold tracking-normal" :class="c.tone">
          {{ c.title }}
          <span class="text-ink-3 tabular font-normal">{{ column(c.statuses).length }}</span>
        </h2>
        <p v-if="!column(c.statuses).length" class="text-ink-3 mt-3 text-sm">{{ c.hint }}</p>
        <ul class="mt-3 flex flex-col gap-2">
          <li v-for="t in column(c.statuses)" :key="t.id">
            <RouterLink :to="`/agents/${t.lastRunId ?? t.id}`" class="border-line bg-surface hover:border-ink-3 block rounded-lg border px-3 py-2.5" :class="t.parentId ? 'ml-4' : ''">
              <p class="font-medium leading-snug">{{ t.title }}</p>
              <p v-if="line(t)" class="mt-0.5 line-clamp-2 text-sm" :class="t.status === 'needs_input' || t.status === 'blocked' ? 'text-wait' : t.status === 'failed' ? 'text-bad' : 'text-ink-2'">{{ line(t) }}</p>
              <p class="text-ink-3 mt-1.5 flex flex-wrap gap-x-3 text-sm">
                <span>{{ t.projectName }}</span>
                <span v-if="t.status === 'failed'" class="text-bad">Failed</span>
                <span v-if="t.parentId && byId.get(t.parentId)">Part of {{ byId.get(t.parentId)!.title }}</span>
                <span v-if="after(t).length && (t.status === 'queued' || t.status === 'todo')">After {{ after(t).join(', ') }}</span>
                <span v-if="t.createdBy === 'manager'">From the manager</span>
              </p>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>

    <NewTask :open="creating" :project="project || undefined" @close="creating = false" />
  </div>
  </div>
  </div>
</template>
