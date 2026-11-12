<script setup lang="ts">
// What a browser sees when it cannot use HeyBotOS: the service is down, or this browser was never let in.
import { state } from '../store'
import BrandMark from './brand/BrandMark.vue'
import BrandWordmark from './brand/BrandWordmark.vue'
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-6">
    <div class="max-w-md">
      <div class="mb-7 flex items-center gap-3">
        <BrandMark :size="44" :state="state.reachable ? 'idle' : 'off'" />
        <BrandWordmark :height="24" />
      </div>
      <template v-if="!state.reachable">
        <h1 class="text-2xl">The HeyBotOS service is not running</h1>
        <p class="text-ink-2 mt-3 text-lg">Open the HeyBotOS app: it starts the service, and this page works again when you reload it.</p>
        <p class="text-ink-3 mt-4 text-sm">Running from the source code instead? Start it there with <code class="font-mono">pnpm start</code>.</p>
      </template>
      <template v-else>
        <h1 class="text-2xl">This browser is not signed in</h1>
        <p class="text-ink-2 mt-3 text-lg">HeyBotOS can start agents that work without asking, so it only talks to a browser that you opened from this computer yourself. Use the HeyBotOS app, or run this in a terminal:</p>
        <pre class="bg-sunken mt-5 rounded-lg px-4 py-3 font-mono text-sm">heybotos open</pre>
        <p class="text-ink-3 mt-4 text-sm">It opens a sign-in link that works once and keeps this browser signed in for six months. From the source code, the command is <code class="font-mono">pnpm heybotos open</code>.</p>
      </template>
    </div>
  </div>
</template>
