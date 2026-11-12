<script setup lang="ts">
// Where a task stands, as a dot and a word.
import { computed } from 'vue'
import type { TaskView } from '@heybotos/protocol'
import { statusTone, statusWord, TONE_VAR } from '../../tracker'
const props = defineProps<{ task: Pick<TaskView, 'status' | 'stage'> }>()
const tone = computed(() => TONE_VAR[statusTone(props.task)])
</script>

<template>
  <span class="pill" :style="{ '--tone': tone }"><span class="dot" :class="{ 'dot-working': task.stage === 'doing' }"></span>{{ statusWord(task) }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
  color: color-mix(in srgb, var(--tone) 80%, var(--ink));
}
.dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 999px;
  background: var(--tone);
  color: var(--tone);
}
</style>
