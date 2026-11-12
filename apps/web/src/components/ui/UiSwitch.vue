<script setup lang="ts">
// On or off. Space or Enter flips it, like a button.
const on = defineModel<boolean>({ required: true })
defineProps<{ label: string; disabled?: boolean }>()
</script>

<template>
  <button type="button" role="switch" class="sw" :aria-checked="on" :aria-label="label" :disabled="disabled" @click="on = !on"><span class="thumb"></span></button>
</template>

<style scoped>
.sw {
  position: relative;
  width: 2rem;
  height: 1.125rem;
  flex-shrink: 0;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--active);
  transition:
    background-color 0.16s,
    border-color 0.16s;
}
.sw:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.sw[aria-checked='true'] {
  background: var(--signal);
  border-color: transparent;
}
.sw:disabled {
  opacity: 0.45;
}
.sw:focus-visible {
  border-radius: 999px;
  outline-offset: 2px;
}
.thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  background: #fff;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.35),
    0 0 0 0.5px rgba(0, 0, 0, 0.08);
  transition: transform 0.18s cubic-bezier(0.3, 0.7, 0.3, 1.25);
}
.sw[aria-checked='true'] .thumb {
  transform: translateX(0.875rem);
}
@media (prefers-reduced-motion: reduce) {
  .thumb {
    transition: none;
  }
}
</style>
