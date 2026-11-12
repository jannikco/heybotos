<script setup lang="ts">
// A short list you add to and take from: folders, servers, patterns. Each change is handed to the
// page at once; `add` answers whether it was taken, and only then is the field emptied.
import { ref } from 'vue'

const props = defineProps<{
  label: string
  items: string[]
  placeholder: string
  addLabel: string
  add: (value: string) => Promise<boolean> | boolean
  remove: (value: string) => unknown
  mono?: boolean
  empty?: string
}>()

const text = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  const v = text.value.trim()
  if (!v || busy.value) return
  if (props.items.includes(v)) {
    text.value = ''
    return
  }
  busy.value = true
  try {
    if (await props.add(v)) text.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <ul v-if="items.length" :aria-label="label">
      <li v-for="item in items" :key="item" class="item">
        <slot name="icon" :item="item"></slot>
        <span class="min-w-0 flex-1 truncate" :class="mono ? 'font-mono text-xs' : ''">{{ item }}</span>
        <slot name="meta" :item="item"></slot>
        <button type="button" class="x" :aria-label="`Remove ${item}`" :title="`Remove ${item}`" @click="remove(item)">
          <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m3 3 6 6M9 3l-6 6" /></svg>
        </button>
      </li>
    </ul>
    <p v-else-if="empty" class="text-ink-3 px-4 py-3">{{ empty }}</p>
    <form class="add" :aria-label="addLabel" @submit.prevent="submit">
      <input v-model="text" class="min-w-0 flex-1 bg-transparent outline-none" :class="mono ? 'font-mono text-xs' : ''" :placeholder="placeholder" :aria-label="placeholder" autocomplete="off" spellcheck="false" />
      <slot name="actions"></slot>
      <button class="btn" :disabled="!text.trim() || busy">{{ addLabel }}</button>
    </form>
  </div>
</template>

<style scoped>
.item {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 2.5rem;
  padding: 0 0.6rem 0 1rem;
  border-bottom: 1px solid var(--line-soft);
}
.x {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 6px;
  color: var(--ink-3);
}
.x:hover {
  background: var(--bad-soft);
  color: var(--bad);
}
.add {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0 0.6rem 0 1rem;
  background: color-mix(in srgb, var(--sunken) 55%, transparent);
}
.add input::placeholder {
  color: var(--ink-3);
}
</style>
