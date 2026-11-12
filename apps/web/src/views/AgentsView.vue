<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AgentCard from '../components/AgentCard.vue'
import AgentRow from '../components/AgentRow.vue'
import NewTask from '../components/NewTask.vue'
import RunPanel from '../components/RunPanel.vue'
import { dayLabel } from '../format'
import { jobs, needsYou, queued, state, working, type Job } from '../store'

const route = useRoute()
const selected = computed(() => (typeof route.params.id === 'string' && route.params.id ? route.params.id : null))
const creating = ref(false)

const summary = computed(() => {
  const parts: string[] = []
  if (needsYou.value.length) parts.push(`${needsYou.value.length} waiting for you`)
  if (working.value.length) parts.push(`${working.value.length} working`)
  if (queued.value.length) parts.push(`${queued.value.length} waiting to start`)
  return parts.length ? `${parts.join(', ')}.` : 'Nobody is working right now.'
})

/** Needs-you first, then whoever is working or waiting, then finished work by day. */
const groups = computed(() => {
  // Whoever is out or waiting for the owner gets a card; finished work is a line.
  const out: Array<{ title: string; jobs: Job[]; cards?: boolean }> = []
  if (needsYou.value.length) out.push({ title: 'Needs you', jobs: needsYou.value, cards: true })
  const now = [...jobs.value.filter((j) => j.state === 'working'), ...jobs.value.filter((j) => j.state === 'waiting' || j.state === 'not-started')]
  if (now.length) out.push({ title: 'Working now', jobs: now, cards: true })
  const byDay = new Map<string, Job[]>()
  for (const j of jobs.value) {
    if (!['done', 'failed', 'stopped'].includes(j.state)) continue
    const day = dayLabel(j.at, state.now)
    byDay.set(day, [...(byDay.get(day) ?? []), j])
  }
  for (const [title, list] of byDay) out.push({ title, jobs: list })
  return out
})

const isSelected = (j: Job) => selected.value !== null && (j.openId === selected.value || j.task?.id === selected.value || state.runs.some((r) => r.id === selected.value && (r.taskId ?? r.sessionId ?? r.id) === j.key))
</script>

<template>
  <div class="lg:grid" :class="selected ? 'lg:grid-cols-[minmax(0,1fr)_minmax(26rem,36rem)]' : ''">
    <section class="min-w-0 pb-12" :class="selected ? 'hidden lg:block' : ''" style="container: list / inline-size">
      <header class="rise flex flex-wrap items-end gap-x-6 gap-y-4 px-6 pb-6 pt-9">
        <div class="min-w-0 flex-1">
          <h1 class="text-3xl sm:text-4xl">Agents</h1>
          <p class="text-ink-2 mt-2 text-lg" aria-live="polite">{{ summary }}</p>
        </div>
        <button class="btn btn-primary" @click="creating = true">New task</button>
      </header>

      <div v-if="!jobs.length" class="px-6 py-10">
        <p class="max-w-[48ch] text-lg">No worker has run yet. Give one a task in any of your projects and you can watch every step it takes here.</p>
      </div>

      <template v-for="g in groups" :key="g.title">
        <h2 class="telemetry px-6 pb-3 pt-6" :class="g.title === 'Needs you' ? '!text-wait' : ''">{{ g.title }}</h2>
        <ul v-if="g.cards" class="cards grid gap-4 px-6">
          <li v-for="j in g.jobs" :key="j.key">
            <AgentCard :job="j" :selected="isSelected(j)" class="h-full" />
          </li>
        </ul>
        <ul v-else class="flex flex-col gap-0.5 px-2">
          <li v-for="j in g.jobs" :key="j.key">
            <AgentRow :job="j" :selected="isSelected(j)" />
          </li>
        </ul>
      </template>
    </section>

    <RunPanel v-if="selected" :id="selected" class="lg:sticky lg:top-0" />
    <NewTask :open="creating" @close="creating = false" />
  </div>
</template>

<style scoped>
.cards {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
}
</style>
