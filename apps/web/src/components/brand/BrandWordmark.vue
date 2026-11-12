<script setup lang="ts">
// "HeyBotOS" as the logo sets it. The letters take the text colour, so it sits on light and dark alike.
import { useId } from 'vue'
import { WORD_BADGE, WORD_BOX, WORD_OS, WORD_TYPE } from './paths'

withDefaults(defineProps<{ height?: number }>(), { height: 18 })
const id = useId()
</script>

<template>
  <svg class="word" :viewBox="WORD_BOX" :height="height" :width="(height * 1320) / 275" role="img" aria-label="HeyBotOS">
    <defs>
      <linearGradient :id="`${id}-b`" x1="0%" y1="95%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#5F22D5" />
        <stop offset="52%" stop-color="#9325BC" />
        <stop offset="100%" stop-color="#FA3B78" />
      </linearGradient>
    </defs>
    <path fill="currentColor" fill-rule="evenodd" :d="WORD_TYPE" />
    <path :fill="`url(#${id}-b)`" fill-rule="evenodd" :d="WORD_BADGE" />
    <path fill="#fff" :d="WORD_OS" />
  </svg>
</template>

<style scoped>
.word {
  display: block;
  flex: none;
  color: var(--ink);
}
</style>
