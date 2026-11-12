<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import CommandPalette from './components/CommandPalette.vue'
import NewTask from './components/NewTask.vue'
import SideBar from './components/SideBar.vue'
import SignedOut from './components/SignedOut.vue'
import { boot, command, state } from './store'
import { startTheme } from './theme'

const route = useRoute()
const router = useRouter()
const creating = ref(false)
/** On a narrow window the sidebar is its own screen. */
const listOnly = computed(() => route.name === 'list')

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}
function onKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    command('palette')
  } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    void router.push('/settings')
  } else if (!typing(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'c') {
      e.preventDefault()
      command('new-task')
    } else if (e.key === '/') {
      e.preventDefault()
      command('focus')
    } else if (e.key === 'Escape' && route.name === 'thread' && route.params.open) {
      void router.push(`/t/${String(route.params.thread)}`)
    }
  }
}

onMounted(() => {
  startTheme()
  window.addEventListener('keydown', onKey)
  void boot()
})
// A new installation starts with a short welcome instead of an empty conversation.
watch(
  () => state.me?.welcomed,
  (welcomed) => {
    if (welcomed === false && route.name !== 'welcome' && route.name !== 'quick') void router.replace('/welcome')
  },
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// A conversation has its own new-task dialog (it knows the project); everywhere else this one opens.
watch(
  () => state.command.n,
  () => {
    if (state.command.name === 'new-task' && route.name !== 'thread') creating.value = true
  },
)
</script>

<template>
  <RouterView v-if="route.meta.bare" />
  <SignedOut v-else-if="state.signedIn === false || (!state.reachable && state.signedIn === null)" />
  <div v-else-if="state.signedIn" class="h-dvh md:grid md:grid-cols-[19.5rem_minmax(0,1fr)]">
    <SideBar :class="listOnly ? '' : 'max-md:hidden'" />
    <main class="h-dvh min-w-0 overflow-y-auto" :class="listOnly ? 'max-md:hidden' : ''">
      <RouterView />
    </main>
    <CommandPalette />
    <NewTask :open="creating" @close="creating = false" />
  </div>
</template>
