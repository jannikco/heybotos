<script setup lang="ts">
// The quick-ask pane: summoned from anywhere with the global shortcut. One line to the manager, then
// it gets out of the way and the main window shows the conversation.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, ApiError } from '../api'
import { boot, managerName, state } from '../store'

const draft = ref('')
const problem = ref('')
const sending = ref(false)
const box = ref<HTMLTextAreaElement | null>(null)

onMounted(() => {
  document.documentElement.classList.add('quick')
  void boot()
  box.value?.focus()
})
onBeforeUnmount(() => document.documentElement.classList.remove('quick'))
watch(
  () => state.command.n,
  () => box.value?.focus(),
)

const cancel = () => window.heybotosDesktop?.quickCancel()

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || sending.value) return
  sending.value = true
  problem.value = ''
  try {
    await api('/api/chat', { method: 'POST', body: { text } })
    draft.value = ''
    window.heybotosDesktop?.quickDone()
  } catch (e) {
    problem.value = (e as ApiError).message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="p-3">
    <form class="pane rounded-[1.6rem] p-2 pl-5" @submit.prevent="send" @keydown.esc="cancel">
      <label for="quick" class="sr-only">Message to the manager</label>
      <div class="flex items-start gap-3">
        <span class="orb mt-3.5 shrink-0" :class="state.chat.activeRunId ? 'orb-busy' : ''" aria-hidden="true"></span>
        <textarea id="quick" ref="box" v-model="draft" rows="2" class="placeholder:text-ink-3 block min-h-[4.2rem] w-full resize-none bg-transparent pt-3 text-xl leading-snug outline-none" :placeholder="`Ask ${managerName} for anything`" @keydown.enter.exact.prevent="send"></textarea>
      </div>
      <div class="flex items-center gap-3 pb-1 pr-1">
        <p class="telemetry flex-1 pl-9">{{ problem || '↵ send   ⇧↵ new line   esc close' }}</p>
        <button class="btn btn-primary" :disabled="sending || !draft.trim()">Send</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.pane {
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border: 1px solid var(--line);
  backdrop-filter: blur(30px) saturate(160%);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--signal) 30%, transparent),
    0 24px 60px -18px #000;
}
</style>
