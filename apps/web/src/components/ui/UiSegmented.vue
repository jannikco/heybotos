<script setup lang="ts" generic="T extends string">
// One choice out of two or three, side by side. Real radio buttons underneath, so the arrow keys work.
import { useId } from 'vue'

const value = defineModel<T>({ required: true })
defineProps<{ label: string; options: Array<{ value: T; label: string }> }>()
const name = useId()
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label">
    <label v-for="o in options" :key="o.value" :class="{ on: value === o.value }">
      <input v-model="value" type="radio" class="sr-only" :name="name" :value="o.value" />
      <span>{{ o.label }}</span>
    </label>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--sunken);
}
label {
  display: inline-flex;
  align-items: center;
  height: 1.5rem;
  padding: 0 0.7rem;
  border-radius: 6px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--ink-2);
  transition:
    background-color 0.12s,
    color 0.12s;
}
label:hover {
  color: var(--ink);
}
label.on {
  color: var(--ink);
  background: var(--knob);
  box-shadow:
    0 0 0 1px var(--line),
    0 1px 2px rgba(0, 0, 0, 0.18);
}
label:has(input:focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--signal) 80%, transparent);
  outline-offset: 1px;
}
</style>
