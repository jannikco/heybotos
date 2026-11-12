<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { ProjectView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { ago } from '../format'
import { loadProjects, state } from '../store'

const router = useRouter()
const query = ref('')
const scanning = ref(false)
const problem = ref('')
const adding = ref(false)
const newName = ref('')
const newAbout = ref('')

onMounted(() => void loadProjects().catch((e) => (problem.value = (e as ApiError).message)))

const worktrees = computed(() => {
  const count = new Map<string, number>()
  for (const p of state.projects) if (p.parentSlug) count.set(p.parentSlug, (count.get(p.parentSlug) ?? 0) + 1)
  return count
})
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  // A linked worktree is listed under its repository, not as a project of its own.
  return state.projects.filter((p) => !p.parentSlug && (!q || `${p.name} ${p.stack} ${p.description}`.toLowerCase().includes(q)))
})

async function scan(): Promise<void> {
  scanning.value = true
  problem.value = ''
  try {
    await loadProjects(true)
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    scanning.value = false
  }
}

async function add(): Promise<void> {
  problem.value = ''
  try {
    const { project } = await api<{ project: ProjectView }>('/api/projects', { method: 'POST', body: { name: newName.value, description: newAbout.value } })
    await loadProjects()
    await router.push(`/projects/${project.slug}`)
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Projects</h1>
      <span class="telemetry">{{ shown.length }} {{ query ? 'match' : 'in all' }}</span>
      <span class="flex-1"></span>
      <button class="btn btn-ghost" :disabled="scanning" @click="scan">{{ scanning ? 'Looking' : 'Look for new folders' }}</button>
      <button class="btn btn-primary" @click="adding = !adding">Add a project</button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="max-w-5xl pb-12 pt-3">
    <p class="text-ink-2 px-5 pb-4">Code projects come from your projects folder; anything else can be added by hand.</p>

    <form v-if="adding" class="border-line bg-surface mx-5 mb-5 rounded-xl border p-4" @submit.prevent="add">
      <p class="text-ink-2 max-w-[60ch]">For work that is not code: research, writing, planning. It gets its own folder for notes and files.</p>
      <div class="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <div>
          <label for="np-name" class="text-sm font-medium">Name</label>
          <input id="np-name" v-model="newName" class="field mt-1" required />
        </div>
        <div>
          <label for="np-about" class="text-sm font-medium">What it is about</label>
          <input id="np-about" v-model="newAbout" class="field mt-1" />
        </div>
        <button class="btn btn-primary self-end" :disabled="!newName.trim()">Add project</button>
      </div>
    </form>

    <p v-if="problem" class="bg-bad-soft text-bad mx-5 mb-4 rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>

    <div class="px-5">
      <label for="p-search" class="sr-only">Find a project</label>
      <input id="p-search" v-model="query" type="search" class="field max-w-md" placeholder="Find a project by name, stack or description" />
    </div>

    <p v-if="state.projectsLoaded && !state.projects.length" class="max-w-[52ch] px-5 py-8 text-lg">
      No projects found. HeyBotOS looks in the folders named under "projectRoots" in its config file.
    </p>
    <p v-else-if="state.projectsLoaded && !shown.length" class="px-5 py-8 text-lg">Nothing matches "{{ query }}".</p>

    <ul class="border-line mt-5 border-t">
      <li v-for="p in shown" :key="p.slug" class="border-line-soft border-b">
        <RouterLink :to="`/projects/${p.slug}`" class="hover:bg-surface/60 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-0.5 px-5 py-3">
          <p class="flex min-w-0 items-baseline gap-3">
            <span class="truncate text-lg font-medium" :class="p.missing ? 'text-ink-3 line-through' : ''">{{ p.name }}</span>
            <span v-if="p.stack" class="text-ink-3 shrink-0 text-sm">{{ p.stack }}</span>
          </p>
          <p class="text-ink-2 tabular self-baseline text-right text-sm">
            <span v-if="p.openTasks" class="text-signal font-medium">{{ p.openTasks }} open task{{ p.openTasks === 1 ? '' : 's' }}</span>
            <span v-else-if="p.lastCommitAt">{{ ago(p.lastCommitAt, state.now) }}</span>
          </p>
          <p class="text-ink-2 col-span-2 truncate text-sm">
            <template v-if="p.missing">The folder is gone.</template>
            <template v-else>{{ p.description || (p.kind === 'other' ? 'No description yet.' : 'No readme or instructions file.') }}</template>
          </p>
          <p v-if="p.dirty || !p.isGit || worktrees.get(p.slug)" class="text-ink-3 col-span-2 flex gap-4 text-sm">
            <span v-if="p.dirty" class="text-wait">Uncommitted changes</span>
            <span v-if="!p.isGit && p.kind === 'code'">Not a git repository</span>
            <span v-if="worktrees.get(p.slug)">{{ worktrees.get(p.slug) }} linked worktree{{ worktrees.get(p.slug) === 1 ? '' : 's' }}</span>
          </p>
        </RouterLink>
      </li>
    </ul>
  </div>
  </div>
  </div>
</template>
