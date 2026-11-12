<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { EngineUsage, RoutingView, TaskKind } from '@heybotos/protocol'
import { api, ApiError } from '../api'
import { ENGINE_NAME, tokens } from '../format'
import { RouterLink } from 'vue-router'
import { state } from '../store'

const engines = ref<EngineUsage[] | null>(null)
const routing = ref<RoutingView | null>(null)
const problem = ref('')
let timer = 0

async function load(): Promise<void> {
  try {
    const res = await api<{ engines: EngineUsage[]; routing: RoutingView }>('/api/usage')
    engines.value = res.engines
    routing.value = res.routing
    problem.value = ''
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
onMounted(() => {
  void load()
  timer = window.setInterval(load, 15_000)
})
onBeforeUnmount(() => window.clearInterval(timer))

const WINDOW_NAME: Record<string, string> = { five_hour: 'Five-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly limit, largest model', limit: 'Usage limit' }
const KIND_NAME: Record<TaskKind, string> = { build: 'Building and fixing', review: 'Reviewing', research: 'Research', write: 'Writing', ops: 'Running and operating', other: 'Everything else' }
const when = (epochSeconds: number | null) => (epochSeconds ? new Date(epochSeconds * 1000).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '')
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function standing(e: EngineUsage): { words: string; tone: string } {
  if (!e.ready) return { words: 'Not signed in', tone: 'text-bad' }
  if (e.coolingUntil) return { words: `On hold until ${time(e.coolingUntil)}`, tone: 'text-wait' }
  if (e.windows.some((w) => (w.utilization ?? 0) >= e.headroom)) return { words: 'Held back for new workers', tone: 'text-wait' }
  return { words: 'Taking work', tone: 'text-ok' }
}
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Usage</h1>
      <span class="flex-1"></span>
      <RouterLink to="/settings/engines" class="btn btn-ghost">Engines and routing</RouterLink>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="max-w-3xl px-5 pb-12 pt-4">
    <p class="text-ink-2 max-w-[64ch]">Every engine runs on your subscription, so the only meter is each plan's usage limit. This is what the tools have reported, and what HeyBotOS does about it.</p>
    <p v-if="problem" class="bg-bad-soft text-bad mt-5 rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>
    <p v-if="!engines && !problem" class="text-ink-2 mt-8">Reading the latest numbers…</p>

    <section v-for="e in engines ?? []" :key="e.engine" class="border-line mt-8 border-t pt-5" :aria-label="ENGINE_NAME[e.engine]">
      <div class="flex flex-wrap items-baseline gap-x-4">
        <h2 class="text-2xl">{{ ENGINE_NAME[e.engine] }}</h2>
        <p class="text-sm font-semibold" :class="standing(e).tone">{{ standing(e).words }}</p>
        <p class="text-ink-2 tabular ml-auto text-sm">
          {{ e.workingNow }} working now, {{ e.runsToday }} turn{{ e.runsToday === 1 ? '' : 's' }} today<template v-if="e.tokensOutToday">, {{ tokens(e.tokensOutToday) }} tokens written</template>
        </p>
      </div>

      <p v-if="e.coolingUntil" class="bg-wait-soft text-wait mt-3 max-w-[64ch] rounded-lg px-3.5 py-2.5">
        The limit is used up. Workers that were cut off wait and carry on by themselves at {{ time(e.coolingUntil) }}; work that had not started moves to the other engine.
      </p>

      <ul v-if="e.windows.length" class="mt-4 flex flex-col gap-4">
        <li v-for="w in e.windows" :key="w.window">
          <div class="flex items-baseline justify-between gap-4">
            <p class="font-medium">{{ WINDOW_NAME[w.window] ?? w.window.replace(/_/g, ' ') }}</p>
            <p class="tabular text-sm" :class="(w.utilization ?? 0) >= e.headroom ? 'text-wait font-semibold' : 'text-ink-2'">
              <template v-if="w.utilization !== null">{{ Math.round(w.utilization * 100) }}% used</template>
              <template v-else>{{ w.status.replace(/_/g, ' ') }}</template>
            </p>
          </div>
          <!-- A meter: how full the window is, with the line above which new workers are held back. -->
          <div class="bg-sunken relative mt-1.5 h-2 rounded-full" role="meter" :aria-valuenow="Math.round((w.utilization ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="`${WINDOW_NAME[w.window] ?? w.window} used`">
            <div class="h-2 rounded-full" :class="(w.utilization ?? 0) >= e.headroom ? 'bg-wait' : 'bg-signal'" :style="{ width: `${Math.min(100, Math.round((w.utilization ?? 0) * 100))}%` }"></div>
            <div v-if="e.headroom < 1" class="bg-ink absolute -top-1 h-4 w-0.5" :style="{ left: `${e.headroom * 100}%` }" aria-hidden="true"></div>
          </div>
          <p v-if="w.resetsAt" class="text-ink-3 mt-1 text-sm">Resets {{ when(w.resetsAt) }}</p>
        </li>
      </ul>
      <p v-else class="text-ink-2 mt-3 max-w-[62ch]">
        {{ e.engine === 'claude' ? 'No reading yet. The first worker turn brings one.' : `${ENGINE_NAME[e.engine]} does not report how much of the plan is used. HeyBotOS only learns about its limit when a turn is refused.` }}
      </p>
      <p v-if="e.headroom < 1 && e.windows.length" class="text-ink-3 mt-3 max-w-[62ch] text-sm">New workers are not started above {{ Math.round(e.headroom * 100) }}% (the mark on the bar), so there is room left for you. The manager is never held back by this.</p>
    </section>

    <section v-if="routing" class="border-line mt-10 border-t pt-5">
      <h2 class="text-2xl">Who does what</h2>
      <dl v-if="routing.mode === 'rules'" class="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-8 gap-y-1.5 sm:max-w-md">
        <template v-for="(engine, kind) in routing.byKind" :key="kind">
          <dt>{{ KIND_NAME[kind] }}</dt>
          <dd class="font-medium">{{ ENGINE_NAME[engine] }}</dd>
        </template>
      </dl>
      <p class="text-ink-2 mt-3 max-w-[62ch]">
        <template v-if="routing.mode === 'balanced'">Automatic: {{ routing.pool.map((x) => ENGINE_NAME[x]).join(', ') }} share the work, each new task going to whichever has room and the fewest workers out.</template>
        <template v-else>{{ routing.fallback ? 'When one engine is on hold or not signed in, its work goes to another.' : 'Work waits for its own engine; it is never moved.' }}</template>
        The manager and you can always name an engine for a single task.
      </p>
      <p class="text-ink-3 mt-2 text-sm">Change these in <RouterLink to="/settings/engines" class="text-ink-2 underline underline-offset-2">Settings</RouterLink>. {{ state.me ? `Up to ${state.me.maxWorkers} workers run at once.` : '' }}</p>
    </section>
  </div>
  </div>
  </div>
</template>
