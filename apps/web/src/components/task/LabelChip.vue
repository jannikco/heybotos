<script setup lang="ts">
// A label, tinted by its own name so the same label looks the same everywhere.
import { computed } from 'vue'
import { hueOf } from '../../store'
const props = defineProps<{ label: string; removable?: boolean }>()
defineEmits<{ remove: [] }>()
const hue = computed(() => hueOf(props.label))
</script>

<template>
  <span class="lab" :style="{ '--h': hue }">
    {{ label }}
    <button v-if="removable" type="button" :aria-label="`Remove the label ${label}`" @click.stop="$emit('remove')">×</button>
  </span>
</template>

<style scoped>
.lab {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  height: 1.125rem;
  padding: 0 0.4rem;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 500;
  white-space: nowrap;
  background: hsl(var(--h) 60% 55% / 0.16);
  color: color-mix(in oklab, hsl(var(--h) 75% 60%) 62%, var(--ink));
}
.lab button {
  margin-right: -0.15rem;
  width: 0.9rem;
  border-radius: 3px;
  line-height: 1;
  opacity: 0.7;
}
.lab button:hover {
  opacity: 1;
  background: hsl(var(--h) 60% 55% / 0.25);
}
</style>
