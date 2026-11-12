<script setup lang="ts">
// A face for everyone you can talk to: the manager (the HeyBotOS robot), each team member, each project.
// The team are our own characters: a soft coloured body with a dark visor; the body's shape and colour come from
// who it is, so the same agent always looks the same. A working agent's visor light sweeps.
import { computed } from 'vue'
import BrandMark from './brand/BrandMark.vue'

const props = withDefaults(defineProps<{ seed: string; hue: number; size?: number; chief?: boolean; state?: 'working' | 'needs' | 'idle' | 'off'; badge?: boolean }>(), { size: 40, chief: false, state: 'idle', badge: true })

// Five body shapes; which one is decided by the seed.
const SHAPES = ['46% 54% 52% 48% / 52% 46% 54% 48%', '38% 62% 46% 54% / 56% 44% 56% 44%', '58% 42% 44% 56% / 44% 52% 48% 56%', '30% 30% 30% 30% / 30% 30% 30% 30%', '50% 50% 34% 34% / 58% 58% 42% 42%']
const hash = computed(() => [...props.seed].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381))
const shape = computed(() => (props.chief ? '50%' : SHAPES[hash.value % SHAPES.length]))
const tilt = computed(() => (props.chief ? 0 : (hash.value % 21) - 10))
const body = computed(() => (props.chief ? 'var(--ink)' : `hsl(${props.hue} 72% 62%)`))
const visor = computed(() => (props.chief ? 'var(--paper)' : `hsl(${props.hue} 45% 14%)`))
</script>

<template>
  <span class="face" :class="[`is-${state}`]" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <!-- The manager is the HeyBotOS robot itself. -->
    <BrandMark v-if="chief" :size="size" :state="state" />
    <span v-else class="body" :style="{ borderRadius: shape, background: body, transform: `rotate(${tilt}deg)` }">
      <span class="visor" :style="{ background: visor }"><span class="glint"></span></span>
    </span>
    <span v-if="badge && (state === 'working' || state === 'needs')" class="badge" :class="state === 'working' ? 'bg-signal' : 'bg-wait'"></span>
  </span>
</template>

<style scoped>
.face {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}
.body {
  position: absolute;
  inset: 4%;
  display: block;
  transition: filter 0.2s;
}
.is-off .body {
  filter: saturate(0.15) brightness(0.7);
}
.visor {
  position: absolute;
  left: 20%;
  right: 20%;
  top: 30%;
  height: 24%;
  border-radius: 999px;
  overflow: hidden;
}
.glint {
  position: absolute;
  top: 22%;
  bottom: 22%;
  left: 14%;
  width: 26%;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
}
.is-working .glint {
  animation: scan 1.5s ease-in-out infinite alternate;
}
@keyframes scan {
  to {
    left: 60%;
  }
}
.badge {
  position: absolute;
  right: -2%;
  bottom: -2%;
  width: 30%;
  height: 30%;
  min-width: 8px;
  min-height: 8px;
  border-radius: 999px;
  border: 2px solid var(--paper);
}
@media (prefers-reduced-motion: reduce) {
  .is-working .glint {
    animation: none;
  }
}
</style>
