<script setup lang="ts">
// One setting: what it is and what it does on the left, the control on the right.
// With `for`, the name is the control's label; with `stack`, the control sits underneath.
defineProps<{ title: string; hint?: string; for?: string; error?: string; stack?: boolean }>()
</script>

<template>
  <div class="set-row" :class="{ stack }">
    <div class="min-w-0">
      <label v-if="$props.for" :for="$props.for" class="set-title">{{ title }}</label>
      <p v-else class="set-title">{{ title }}</p>
      <p v-if="hint || $slots.hint" class="set-hint"><slot name="hint">{{ hint }}</slot></p>
      <p v-if="error" class="set-error" role="alert">{{ error }}</p>
    </div>
    <div class="flex min-w-0 items-center gap-3" :class="stack ? '' : 'justify-self-end'"><slot></slot></div>
  </div>
</template>
