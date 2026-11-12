<script setup lang="ts">
// A panel of settings that belong together, with an optional heading above it.
import { useId } from 'vue'

defineProps<{ title?: string; hint?: string; label?: string }>()
const id = useId()
</script>

<template>
  <section class="mt-7" :aria-labelledby="title ? id : undefined" :aria-label="title ? undefined : label">
    <div v-if="title" class="mb-2.5 flex items-end gap-3 px-1">
      <div class="min-w-0 flex-1">
        <h3 :id="id" class="text-lg">{{ title }}</h3>
        <p v-if="hint" class="set-hint">{{ hint }}</p>
      </div>
      <slot name="aside"></slot>
    </div>
    <div class="set-panel"><slot></slot></div>
  </section>
</template>
