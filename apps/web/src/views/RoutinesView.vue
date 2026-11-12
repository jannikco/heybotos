<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RoutineView } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { ago } from '../format'
import { state } from '../store'

const routines = ref<RoutineView[] | null>(null)
const problem = ref('')
const adding = ref(false)
const title = ref('')
const prompt = ref('')
const how = ref<'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom'>('weekdays')
const time = ref('07:30')
const day = ref('1')
const custom = ref('0 9 * * 1')

const DAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] as const

/** The schedule the form describes, as the five-field expression the daemon stores. */
const schedule = computed(() => {
  const [h = '7', m = '30'] = time.value.split(':')
  const hm = `${Number(m)} ${Number(h)}`
  if (how.value === 'daily') return `${hm} * * *`
  if (how.value === 'weekdays') return `${hm} * * 1-5`
  if (how.value === 'weekly') return `${hm} * * ${day.value}`
  if (how.value === 'hourly') return '0 * * * *'
  return custom.value
})

async function load(): Promise<void> {
  try {
    routines.value = (await api<{ routines: RoutineView[] }>('/api/routines')).routines
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
onMounted(load)

async function act(fn: () => Promise<unknown>): Promise<void> {
  problem.value = ''
  try {
    await fn()
    await load()
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}

const add = () =>
  act(async () => {
    await api('/api/routines', { method: 'POST', body: { title: title.value, schedule: schedule.value, prompt: prompt.value } })
    title.value = ''
    prompt.value = ''
    adding.value = false
  })
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '')
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Routines</h1>
      <span class="flex-1"></span>
      <button class="btn btn-primary" @click="adding = !adding">Add a routine</button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="max-w-3xl px-5 pb-12 pt-4">
    <p class="text-ink-2 max-w-[64ch]">Things {{ state.me?.managerName ?? 'the manager' }} does by itself on a schedule. When one comes due it works as if you had just asked, and answers in the conversation.</p>

    <p v-if="problem" class="bg-bad-soft text-bad mt-5 rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>

    <form v-if="adding" class="border-line bg-surface mt-6 rounded-xl border p-5" aria-label="New routine" @submit.prevent="add">
      <label for="r-title" class="block text-sm font-medium">Name</label>
      <input id="r-title" v-model="title" class="field mt-1.5" placeholder="Morning brief" required />

      <label for="r-prompt" class="mt-4 block text-sm font-medium">What should the manager do each time?</label>
      <textarea id="r-prompt" v-model="prompt" class="field mt-1.5 min-h-28 resize-y" placeholder="Tell me what the workers finished since yesterday, what is waiting for me, and what you suggest doing today." required></textarea>

      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label for="r-how" class="block text-sm font-medium">How often</label>
          <select id="r-how" v-model="how" class="field mt-1.5">
            <option value="weekdays">Every weekday</option>
            <option value="daily">Every day</option>
            <option value="weekly">Once a week</option>
            <option value="hourly">Every hour</option>
            <option value="custom">Something else</option>
          </select>
        </div>
        <div v-if="how === 'weekly'">
          <label for="r-day" class="block text-sm font-medium">Day</label>
          <select id="r-day" v-model="day" class="field mt-1.5">
            <option v-for="[value, name] in DAYS" :key="value" :value="value">{{ name }}</option>
          </select>
        </div>
        <div v-if="how !== 'hourly' && how !== 'custom'">
          <label for="r-time" class="block text-sm font-medium">At</label>
          <input id="r-time" v-model="time" type="time" class="field mt-1.5" required />
        </div>
        <div v-if="how === 'custom'" class="sm:col-span-2">
          <label for="r-custom" class="block text-sm font-medium">Schedule</label>
          <input id="r-custom" v-model="custom" class="field mt-1.5 font-mono text-sm" spellcheck="false" required />
          <p class="text-ink-3 mt-1 text-sm">Five parts: minute, hour, day of the month, month, day of the week (1 is Monday).</p>
        </div>
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" @click="adding = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!title.trim() || !prompt.trim()">Add routine</button>
      </div>
    </form>

    <p v-if="routines && !routines.length && !adding" class="mt-8 max-w-[56ch] text-lg">No routines yet. Add one here, or ask the manager: "every weekday at 7:30, tell me what needs my attention".</p>

    <ul v-if="routines?.length" class="border-line mt-7 border-t">
      <li v-for="r in routines" :key="r.id" class="border-line border-b py-4">
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 class="text-xl" :class="r.enabled ? '' : 'text-ink-3'">{{ r.title }}</h2>
          <p class="text-ink-2">{{ r.when }}</p>
          <p v-if="!r.enabled" class="text-ink-3 text-sm font-semibold">Switched off</p>
        </div>
        <p class="text-ink-2 mt-1.5 max-w-[68ch] whitespace-pre-wrap">{{ r.prompt }}</p>
        <p class="text-ink-3 mt-1.5 text-sm">
          <template v-if="r.nextAt">Next: {{ when(r.nextAt) }}.</template>
          <template v-if="r.lastFiredAt"> Last ran {{ ago(r.lastFiredAt, state.now) }}.</template>
          <template v-if="r.createdBy === 'manager'"> Set up by the manager.</template>
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn" @click="act(() => api(`/api/routines/${r.id}/run`, { method: 'POST' }))">Run it now</button>
          <button class="btn" @click="act(() => api(`/api/routines/${r.id}/${r.enabled ? 'disable' : 'enable'}`, { method: 'POST' }))">{{ r.enabled ? 'Switch off' : 'Switch on' }}</button>
          <button class="btn btn-danger" @click="act(() => api(`/api/routines/${r.id}`, { method: 'DELETE' }))">Remove</button>
        </div>
      </li>
    </ul>
  </div>
  </div>
  </div>
</template>
