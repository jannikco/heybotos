<script setup lang="ts">
// Priority as a shape, so it reads without colour: two arrows up, one up, a dash, one down.
import type { TaskPriority } from '@heybotos/protocol'
defineProps<{ priority: TaskPriority; label?: boolean }>()
const WORDS: Record<TaskPriority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }
const PATHS: Record<TaskPriority, string> = {
  urgent: 'M3.5 8 8 3.5 12.5 8M3.5 12.5 8 8l4.5 4.5',
  high: 'M3.5 10 8 5.5l4.5 4.5',
  normal: 'M4 8h8',
  low: 'M3.5 6 8 10.5 12.5 6',
}
</script>

<template>
  <span class="pm" :class="priority" :title="label ? undefined : `${WORDS[priority]} priority`">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" :aria-label="`${WORDS[priority]} priority`"><path :d="PATHS[priority]" /></svg>
    <span v-if="label">{{ WORDS[priority] }}</span>
  </span>
</template>

<style scoped>
.pm {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--ink-3);
  white-space: nowrap;
}
.pm svg {
  width: 0.875rem;
  height: 0.875rem;
  flex: none;
}
.pm.urgent,
.pm.high {
  color: var(--ink);
}
.pm.urgent svg {
  stroke-width: 2.4;
}
</style>
