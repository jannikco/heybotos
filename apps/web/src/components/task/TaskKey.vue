<script setup lang="ts">
// A task's name (BOT-12), as a link to its page unless `plain`.
import { RouterLink } from 'vue-router'
defineProps<{ k: string; plain?: boolean; done?: boolean }>()
</script>

<template>
  <span v-if="plain" class="tkey" :class="{ done }">{{ k }}</span>
  <RouterLink v-else :to="`/task/${k}`" class="tkey link" :class="{ done }">{{ k }}</RouterLink>
</template>

<style scoped>
.tkey {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--ink-3);
  white-space: nowrap;
}
.tkey.done {
  text-decoration: line-through;
}
.link:hover {
  color: var(--signal);
  text-decoration: underline;
}
</style>
