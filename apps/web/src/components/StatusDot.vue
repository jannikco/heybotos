<script setup lang="ts">
import type { Tone } from '../format'

defineProps<{ tone: Tone; pulse?: boolean; label: string }>()
</script>

<template>
  <span
    class="inline-block size-2.5 shrink-0 rounded-full"
    :style="tone === 'muted' ? undefined : { boxShadow: `0 0 10px ${{ signal: 'var(--signal)', wait: 'var(--wait)', ok: 'var(--ok)', bad: 'var(--bad)' }[tone]}` }"
    :class="{
      'bg-signal': tone === 'signal',
      'dot-working': pulse,
      'bg-wait': tone === 'wait',
      'bg-ok': tone === 'ok',
      'bg-bad': tone === 'bad',
      'border-ink-3 border-[1.5px] bg-transparent': tone === 'muted',
    }"
    role="img"
    :aria-label="label"
  ></span>
</template>
