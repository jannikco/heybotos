<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { clock, elapsed, ENGINE_NAME, folderName, jobLine, JOB_TONE, JOB_WORDS } from '../format'
import { state, type Job } from '../store'
import ActivityStrip from './ActivityStrip.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ job: Job; selected: boolean }>()

const live = computed(() => props.job.state === 'working')
const run = computed(() => props.job.run)
const seconds = computed(() => (run.value?.startedAt ? ((run.value.endedAt ?? state.now) - run.value.startedAt) / 1000 : 0))
const tone = computed(() => JOB_TONE[props.job.state])
</script>

<template>
  <RouterLink :to="`/agents/${job.openId}`" class="row grid items-center gap-x-4 gap-y-1 rounded-2xl px-4 py-3" :class="selected ? 'on' : ''" :aria-current="selected ? 'true' : undefined">
    <StatusDot :tone="tone" :pulse="live" :label="JOB_WORDS[job.state]" class="row-dot" />
    <div class="row-main min-w-0">
      <p class="truncate text-lg font-medium leading-snug">{{ job.title }}</p>
      <p class="truncate text-sm" :class="tone === 'bad' ? 'text-bad' : tone === 'wait' ? 'text-wait' : 'text-ink-2'">{{ jobLine(job).split('\n')[0] }}</p>
    </div>
    <div class="row-strip min-w-0">
      <ActivityStrip :ticks="run ? (state.pulse[run.id] ?? []) : []" :seconds="seconds" :live="live" />
      <p class="telemetry mt-1.5 flex items-center gap-2">
        <span>{{ ENGINE_NAME[run?.engine ?? job.task?.engine ?? 'claude'] }}</span>
        <span class="truncate">/ {{ job.task?.projectName ?? (run ? folderName(run.cwd) : '') }}</span>
        <span v-if="run && run.turn > 1" class="shrink-0">/ turn {{ run.turn }}</span>
      </p>
    </div>
    <p class="row-time tabular text-right text-sm">
      <span v-if="run" class="text-ink-2 block font-medium">{{ elapsed(run, state.now) }}</span>
      <span class="telemetry block">{{ clock(job.at) }}</span>
    </p>
  </RouterLink>
</template>

<style scoped>
.row {
  grid-template-columns: 0.75rem minmax(0, 1fr) 3.5rem;
  grid-template-areas:
    'dot main time'
    '. strip strip';
  border: 1px solid transparent;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}
.row:hover {
  background: var(--glass);
  border-color: var(--line-soft);
}
.row.on {
  background: var(--glass-strong);
  border-color: var(--line);
}
.row-dot {
  grid-area: dot;
}
.row-main {
  grid-area: main;
}
.row-strip {
  grid-area: strip;
}
.row-time {
  grid-area: time;
}
@container list (min-width: 44rem) {
  .row {
    grid-template-columns: 0.75rem minmax(0, 1.25fr) minmax(9rem, 1fr) 3.5rem;
    grid-template-areas: 'dot main strip time';
  }
}
</style>
