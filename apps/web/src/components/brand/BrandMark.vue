<script setup lang="ts">
// The HeyBotOS robot. It is also the manager's face, so it can show what the manager is up to:
// while it works the sparks by its antenna flicker, and it blinks now and then.
import { useId } from 'vue'
import { MARK_BOX, MARK_FACE, MARK_SCREEN, MARK_SHELL, MARK_SPARKS } from './paths'

withDefaults(defineProps<{ size?: number; state?: 'working' | 'needs' | 'idle' | 'off'; label?: string }>(), { size: 40, state: 'idle' })
// Several marks can be on one page; each needs a gradient of its own to point at.
const id = useId()
</script>

<template>
  <svg class="mark" :class="`is-${state}`" :viewBox="MARK_BOX" :width="size" :height="size" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <defs>
      <linearGradient :id="`${id}-g`" x1="0%" y1="85%" x2="100%" y2="10%">
        <stop offset="0%" stop-color="#315DFB" />
        <stop offset="36%" stop-color="#8156F7" />
        <stop offset="68%" stop-color="#BB58E7" />
        <stop offset="100%" stop-color="#F459B4" />
      </linearGradient>
    </defs>
    <path class="sparks" :fill="`url(#${id}-g)`" fill-rule="evenodd" :d="MARK_SPARKS" />
    <path :fill="`url(#${id}-g)`" fill-rule="evenodd" :d="MARK_SHELL" />
    <path class="eyes" fill="#fff" :d="MARK_SCREEN" />
    <path fill="#0A102A" fill-rule="evenodd" :d="MARK_FACE" />
    <!-- A lid that closes over the eyes for a moment. -->
    <rect class="lid" x="250" y="335" width="270" height="100" rx="20" fill="#0A102A" />
  </svg>
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
  overflow: visible;
  transition: filter 0.2s;
}
.is-off {
  filter: saturate(0.1) brightness(0.75);
}
.sparks {
  transform-box: fill-box;
  transform-origin: 0% 100%;
}
.is-working .sparks {
  animation: spark 0.9s ease-in-out infinite;
}
.is-needs .sparks {
  animation: spark 1.8s ease-in-out infinite;
}
@keyframes spark {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.25;
    transform: scale(0.82);
  }
}
.lid {
  transform-box: fill-box;
  transform-origin: 50% 0%;
  transform: scaleY(0);
}
.is-working .lid,
.is-idle .lid,
.is-needs .lid {
  animation: blink 6s linear infinite;
}
@keyframes blink {
  0%,
  96%,
  100% {
    transform: scaleY(0);
  }
  98% {
    transform: scaleY(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sparks,
  .lid {
    animation: none !important;
  }
}
</style>
