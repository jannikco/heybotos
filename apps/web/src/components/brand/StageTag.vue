<script setup lang="ts">
// A small "Beta" beside the name, for as long as HeyBotOS is one.
import { state } from '../../store'
</script>

<template>
  <span v-if="state.me?.stage" class="stage" title="HeyBotOS is in beta: expect rough edges, and changes between versions.">{{ state.me.stage }}</span>
</template>

<style scoped>
.stage {
  display: inline-flex;
  align-items: center;
  height: 1.05rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--signal) 55%, transparent);
  color: var(--signal);
  font-size: 0.625rem;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: capitalize;
  white-space: nowrap;
}
</style>
