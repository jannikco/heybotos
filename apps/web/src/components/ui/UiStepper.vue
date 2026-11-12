<script setup lang="ts">
// A small number with a minus and a plus. Typing works too; the number is taken when the field is
// left or Enter is pressed, and kept inside its limits.
import { ref, watch } from 'vue'

const value = defineModel<number>({ required: true })
const props = withDefaults(defineProps<{ label: string; min: number; max: number; step?: number; unit?: string; id?: string }>(), { step: 1 })

const text = ref(String(value.value))
watch(value, (v) => (text.value = String(v)))

function set(n: number): void {
  const fixed = Math.min(props.max, Math.max(props.min, Math.round(n)))
  text.value = String(fixed)
  if (fixed !== value.value) value.value = fixed
}
/** A typed number is taken as it is; the buttons move in steps. */
function take(): void {
  const n = Number(text.value.replace(',', '.'))
  if (text.value.trim() === '' || !Number.isFinite(n)) text.value = String(value.value)
  else set(n)
}
</script>

<template>
  <div class="step">
    <button type="button" :aria-label="`${label}: one less`" :disabled="value <= min" @click="set(value - step)">
      <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 6h7" /></svg>
    </button>
    <span class="mid">
      <input
        :id="id"
        v-model="text"
        type="text"
        inputmode="numeric"
        role="spinbutton"
        autocomplete="off"
        :aria-label="label"
        :aria-valuenow="value"
        :aria-valuemin="min"
        :aria-valuemax="max"
        :style="{ width: `${Math.max(2, String(max).length) + 0.6}ch` }"
        @change="take"
        @keydown.enter.prevent="take"
        @keydown.up.prevent="set(value + step)"
        @keydown.down.prevent="set(value - step)"
      />
      <span v-if="unit" class="unit">{{ unit }}</span>
    </span>
    <button type="button" :aria-label="`${label}: one more`" :disabled="value >= max" @click="set(value + step)">
      <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 6h7M6 2.5v7" /></svg>
    </button>
  </div>
</template>

<style scoped>
.step {
  display: inline-flex;
  align-items: stretch;
  height: 1.75rem;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--sunken);
  overflow: hidden;
}
.step:focus-within {
  border-color: color-mix(in srgb, var(--signal) 75%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 20%, transparent);
}
button {
  display: grid;
  place-items: center;
  width: 1.75rem;
  color: var(--ink-2);
  transition: background-color 0.1s;
}
button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
button:active:not(:disabled) {
  background: var(--active);
}
button:disabled {
  opacity: 0.3;
}
button:focus-visible {
  outline-offset: -2px;
}
.mid {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0 0.45rem;
  border-inline: 1px solid var(--line-soft);
}
input {
  background: transparent;
  text-align: center;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.unit {
  font-size: 0.75rem;
  color: var(--ink-3);
}
</style>
