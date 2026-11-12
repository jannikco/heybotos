<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ENGINE_NAME } from '../format'
import { refreshHealth, state } from '../store'

const checking = ref(false)
async function check(): Promise<void> {
  checking.value = true
  try {
    await refreshHealth(true)
  } finally {
    checking.value = false
  }
}
onMounted(() => void refreshHealth().catch(() => {}))
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <h1>Health</h1>
      <span class="flex-1"></span>
      <button class="btn" :disabled="checking" @click="check">{{ checking ? 'Checking' : 'Check again' }}</button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="max-w-3xl px-5 pb-12 pt-4">
    <p class="text-ink-2 max-w-[64ch]">HeyBotOS only runs the official command-line tools with their subscription logins. This is what they report about themselves.</p>

    <p v-if="!state.health" class="text-ink-2 mt-8">Asking the tools…</p>
    <ul v-else class="border-line mt-8 border-t">
      <li v-for="e in state.health" :key="e.engine" class="border-line grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 border-b py-4">
        <h2 class="text-xl">{{ ENGINE_NAME[e.engine] }}</h2>
        <p class="self-center text-sm font-semibold" :class="e.loggedIn ? 'text-ok' : 'text-bad'">{{ e.loggedIn ? 'Ready' : e.found ? 'Needs sign-in' : 'Not installed' }}</p>
        <p class="text-ink-2 col-span-2 max-w-[68ch]">{{ e.detail }}</p>
        <p v-if="e.bin" class="text-ink-3 col-span-2 truncate font-mono text-xs">{{ e.bin }} ({{ e.version }})</p>
      </li>
    </ul>

    <dl v-if="state.me" class="mt-8 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
      <dt class="text-ink-3">Data folder</dt>
      <dd class="truncate font-mono text-sm">{{ state.me.home }}</dd>
      <dt class="text-ink-3">Workers at once</dt>
      <dd>{{ state.me.maxWorkers }}</dd>
    </dl>
  </div>
  </div>
  </div>
</template>
