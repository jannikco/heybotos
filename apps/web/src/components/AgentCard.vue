<script setup lang="ts">
// A worker that is out right now, or one that needs the owner: a pane of glass lit in its state's colour.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { elapsed, ENGINE_NAME, folderName, jobLine, JOB_WORDS } from '../format'
import { state, type Job } from '../store'
import ActivityStrip from './ActivityStrip.vue'

const props = defineProps<{ job: Job; selected: boolean }>()

const run = computed(() => props.job.run)
const live = computed(() => props.job.state === 'working')
const calling = computed(() => props.job.state === 'needs-you' || props.job.state === 'blocked')
const seconds = computed(() => (run.value?.startedAt ? ((run.value.endedAt ?? state.now) - run.value.startedAt) / 1000 : 0))
const tone = computed(() => (live.value ? 'var(--signal)' : calling.value ? 'var(--wait)' : 'var(--ink-3)'))
</script>

<template>
  <RouterLink :to="`/agents/${job.openId}`" class="agent-card group relative flex flex-col overflow-hidden rounded-3xl p-5" :class="{ on: selected, live, calling }" :style="{ '--tone': tone }" :aria-current="selected ? 'true' : undefined">
    <div class="flex items-center gap-2.5">
      <span class="size-2.5 rounded-full" :class="live || calling ? 'dot-working' : ''" :style="{ background: tone, color: tone }" role="img" :aria-label="JOB_WORDS[job.state]"></span>
      <span class="telemetry" :style="{ color: live || calling ? tone : undefined }">{{ JOB_WORDS[job.state] }}</span>
      <span v-if="run?.startedAt" class="font-display tabular ml-auto text-xl font-semibold tracking-tight" :class="live ? 'text-ink' : 'text-ink-2'">{{ elapsed(run, state.now) }}</span>
    </div>

    <p class="font-display mt-4 text-xl font-semibold leading-tight tracking-tight">{{ job.title }}</p>
    <p class="mt-1.5 line-clamp-2 min-h-[2.6em] leading-snug" :class="calling ? 'text-wait' : live ? 'working-text' : 'text-ink-2'">{{ jobLine(job).split('\n')[0] }}</p>

    <div class="mt-auto pt-5">
      <ActivityStrip v-if="run?.startedAt" :ticks="run ? (state.pulse[run.id] ?? []) : []" :seconds="seconds" :live="live" tall />
      <p class="telemetry mt-3 flex items-center gap-2">
        <span class="inline-block size-1.5" :class="(run?.engine ?? job.task?.engine) === 'codex' ? 'rounded-[1px]' : 'rounded-full'" :style="{ background: 'var(--ink-3)' }" aria-hidden="true"></span>
        <span>{{ ENGINE_NAME[run?.engine ?? job.task?.engine ?? 'claude'] }}</span>
        <span class="truncate">/ {{ job.task?.projectName ?? (run ? folderName(run.cwd) : '') }}</span>
        <span v-if="run && run.turn > 1" class="ml-auto shrink-0">turn {{ run.turn }}</span>
      </p>
    </div>
  </RouterLink>
</template>

<style scoped>
.agent-card {
  min-height: 11.5rem;
  background:
    radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--tone) 13%, transparent), transparent 55%),
    var(--glass);
  border: 1px solid var(--line);
  backdrop-filter: blur(18px);
  transition:
    transform 0.25s cubic-bezier(0.2, 0.7, 0.2, 1),
    border-color 0.2s,
    box-shadow 0.25s;
}
.agent-card.live,
.agent-card.calling {
  border-color: color-mix(in srgb, var(--tone) 38%, transparent);
  box-shadow: 0 0 44px -18px var(--tone);
}
.agent-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--tone) 65%, transparent);
  box-shadow: 0 18px 50px -22px var(--tone);
}
.agent-card.on {
  border-color: var(--tone);
  box-shadow:
    0 0 0 1px var(--tone),
    0 0 54px -14px var(--tone);
}
/* A slow light travelling along the top edge of a worker that is out. */
.agent-card.live::before {
  content: '';
  position: absolute;
  top: 0;
  left: -40%;
  width: 40%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--ink), transparent);
  animation: travel 3.2s linear infinite;
}
@keyframes travel {
  to {
    left: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-card.live::before {
    animation: none;
    display: none;
  }
  .agent-card:hover {
    transform: none;
  }
}
</style>
