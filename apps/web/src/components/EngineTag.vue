<script setup lang="ts">
import type { Engine } from '@heybotos/protocol'
import { ENGINE_NAME } from '../format'

defineProps<{ engine: Engine }>()
</script>

<template>
  <!-- Shape, not brand colour, tells the engines apart: a round mark for Claude, a square one for Codex, a diamond for Grok. -->
  <span class="text-ink-2 inline-flex items-center gap-1.5 text-sm">
    <span class="bg-ink-2 inline-block size-2" :class="engine === 'claude' ? 'rounded-full' : engine === 'codex' ? 'rounded-[2px]' : 'rotate-45 rounded-[1px]'" aria-hidden="true"></span>
    {{ ENGINE_NAME[engine] }}
  </span>
</template>
