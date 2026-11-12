<script setup lang="ts">
// A run drawn as a strip of time: every tool call, hand-off, message and error is a bar of light
// where it happened. For a working agent the right edge is "now", so the bars drift left as it works.
import { computed, useId } from 'vue'
import type { Tick } from '../store'

const props = withDefaults(defineProps<{ ticks: Tick[]; seconds: number; live: boolean; tall?: boolean }>(), { tall: false })

const id = useId()
const W = 240
const H = computed(() => (props.tall ? 44 : 22))
const span = computed(() => Math.max(props.seconds, 45))
const marks = computed(() =>
  props.ticks.map(([t, kind]) => ({
    x: Math.min(W - 1, Math.max(1, (t / span.value) * W)),
    kind,
    h: (kind === 'say' ? 0.34 : kind === 'tool' ? 0.6 : 0.88) * (H.value - 3),
  })),
)
const edge = computed(() => Math.min(W, (props.seconds / span.value) * W))
const label = computed(() => {
  const n = props.ticks.filter((t) => t[1] !== 'say').length
  return `${n} action${n === 1 ? '' : 's'} so far`
})
const COLOR = { tool: 'var(--signal)', say: 'var(--ink-2)', handoff: 'var(--signal-2)', error: 'var(--bad)' } as const
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="strip w-full" :class="tall ? 'h-11' : 'h-[22px]'" role="img" :aria-label="label">
    <defs>
      <linearGradient :id="`${id}-trail`" x1="0" x2="1">
        <stop offset="0%" stop-color="var(--signal)" stop-opacity="0" />
        <stop offset="100%" stop-color="var(--signal)" stop-opacity="0.55" />
      </linearGradient>
    </defs>
    <line x1="0" :y1="H - 1" :x2="W" :y2="H - 1" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" />
    <rect v-if="live" x="0" y="0" :width="edge" :height="H - 1" :fill="`url(#${id}-trail)`" opacity="0.18" />
    <line x1="0" :y1="H - 1" :x2="edge" :y2="H - 1" :stroke="live ? 'var(--signal)' : 'var(--ink-3)'" stroke-width="1" vector-effect="non-scaling-stroke" />
    <line
      v-for="(m, i) in marks"
      :key="i"
      :x1="m.x"
      :x2="m.x"
      :y1="H - 1"
      :y2="H - 1 - m.h"
      :stroke="COLOR[m.kind]"
      stroke-width="2"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
      :class="live ? 'lit-mark' : ''"
    />
    <line v-if="live" :x1="edge" :x2="edge" y1="0" :y2="H - 1" stroke="var(--ink)" stroke-width="1.5" vector-effect="non-scaling-stroke" class="head" />
  </svg>
</template>

<style scoped>
.strip {
  overflow: visible;
}
.lit-mark {
  filter: drop-shadow(0 0 3px currentColor) drop-shadow(0 0 2px var(--signal));
}
.head {
  filter: drop-shadow(0 0 6px var(--signal));
}
</style>
