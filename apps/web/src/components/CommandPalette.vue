<script setup lang="ts">
// Find or run anything: conversations, team members, tasks, screens, commands. ⌘K from anywhere.
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { command, hueOf, managerName, state } from '../store'
import { isLight, setTheme } from '../theme'
import AgentFace from './AgentFace.vue'

const router = useRouter()
const dialog = ref<HTMLDialogElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const at = ref(0)

interface Item {
  key: string
  label: string
  hint: string
  group: string
  face?: { seed: string; hue: number; chief?: boolean }
  run: () => void
}

const all = computed<Item[]>(() => {
  const go = (path: string) => () => void router.push(path)
  const items: Item[] = [
    { key: 'chief', label: managerName.value, hint: 'Conversation', group: 'People', face: { seed: 'chief', hue: 250, chief: true }, run: go('/t/chief') },
    ...state.staff.filter((m) => !m.isChief).map((m) => ({ key: `m-${m.id}`, label: m.name, hint: m.title, group: 'People', face: { seed: m.id, hue: m.hue }, run: go(`/team/${m.id}`) })),
    { key: 'c-task', label: 'New task', hint: 'C', group: 'Do', run: () => command('new-task') },
    { key: 'c-inbox', label: 'Inbox', hint: 'Waiting for you', group: 'Go to', run: go('/inbox') },
    { key: 'c-board', label: 'Board', hint: 'Every task by where it stands', group: 'Go to', run: go('/board') },
    { key: 'c-work', label: 'All work', hint: 'Every worker run', group: 'Go to', run: go('/agents') },
    { key: 'c-projects', label: 'All projects', hint: '', group: 'Go to', run: go('/projects') },
    { key: 'c-routines', label: 'Routines', hint: 'Things done on a schedule', group: 'Go to', run: go('/routines') },
    { key: 'c-usage', label: 'Usage', hint: 'Subscription limits', group: 'Go to', run: go('/usage') },
    { key: 'c-health', label: 'Health', hint: 'Are the tools signed in', group: 'Go to', run: go('/health') },
    { key: 'c-settings', label: 'Settings', hint: '⌘,', group: 'Go to', run: go('/settings') },
    { key: 'c-set-manager', label: `Settings: ${managerName.value}`, hint: 'Name, model, effort', group: 'Go to', run: go('/settings/manager') },
    { key: 'c-set-team', label: 'Settings: Team', hint: 'Members, add one', group: 'Go to', run: go('/settings/team') },
    { key: 'c-set-engines', label: 'Settings: Engines', hint: 'Models, limits, who does what', group: 'Go to', run: go('/settings/engines') },
    { key: 'c-set-connectors', label: 'Settings: Connectors', hint: 'Systems the team can reach', group: 'Go to', run: go('/settings/connectors') },
    { key: 'c-set-safety', label: 'Settings: Safety', hint: 'Servers, what waits for your yes', group: 'Go to', run: go('/settings/safety') },
    { key: 'c-theme', label: 'Switch between dark and light', hint: '', group: 'Do', run: () => setTheme(isLight() ? 'dark' : 'light') },
    ...state.projects.filter((p) => !p.parentSlug && !p.missing).map((p) => ({ key: `p-${p.slug}`, label: p.name, hint: p.stack || 'Project', group: 'Projects', face: { seed: p.slug, hue: hueOf(p.slug) }, run: go(`/t/${p.slug}`) })),
    ...state.tasks.slice(0, 80).map((t) => ({ key: `t-${t.id}`, label: t.title, hint: `${t.projectName}${t.assigneeName ? `, ${t.assigneeName}` : ''}`, group: 'Tasks', run: go(`/t/${t.project}/${t.lastRunId ?? t.id}`) })),
  ]
  return items
})

const shown = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = all.value.filter((i) => words.every((w) => `${i.label} ${i.hint} ${i.group}`.toLowerCase().includes(w)))
  // Without a query: people and commands, not all 130 projects.
  return (words.length ? hit : hit.filter((i) => i.group !== 'Projects' && i.group !== 'Tasks')).slice(0, 40)
})
watch(shown, () => (at.value = 0))

function open(): void {
  query.value = ''
  at.value = 0
  dialog.value?.showModal()
  void nextTick(() => input.value?.focus())
}
function pick(i: Item | undefined): void {
  if (!i) return
  dialog.value?.close()
  i.run()
}
function move(by: number): void {
  at.value = (at.value + by + shown.value.length) % Math.max(1, shown.value.length)
  void nextTick(() => dialog.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
}
watch(
  () => state.command.n,
  () => {
    if (state.command.name === 'palette') open()
  },
)
</script>

<template>
  <dialog ref="dialog" class="palette m-auto mt-[12vh] w-[min(38rem,calc(100vw-2rem))] rounded-xl p-0" aria-label="Find or run anything" @click.self="dialog?.close()">
    <div class="border-line-soft flex items-center gap-2.5 border-b px-3.5">
      <svg viewBox="0 0 16 16" class="text-ink-3 size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></svg>
      <input
        ref="input"
        v-model="query"
        class="placeholder:text-ink-3 h-11 flex-1 bg-transparent text-lg outline-none"
        placeholder="Find a project, a person, a task, or a command"
        aria-label="Search"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="pick(shown[at])"
      />
      <span class="kbd">esc</span>
    </div>
    <ul id="palette-list" class="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
      <li v-if="!shown.length" class="text-ink-3 px-3 py-6 text-center">Nothing matches "{{ query }}".</li>
      <li v-for="(i, n) in shown" :key="i.key" role="option" :aria-selected="n === at" class="item" :class="n === at ? 'on' : ''" @mousemove="at = n" @click="pick(i)">
        <AgentFace v-if="i.face" :seed="i.face.seed" :hue="i.face.hue" :chief="i.face.chief" :size="20" :badge="false" />
        <span v-else class="text-ink-3 grid size-5 place-items-center text-xs">›</span>
        <span class="truncate">{{ i.label }}</span>
        <span class="text-ink-3 ml-auto shrink-0 truncate pl-4 text-xs">{{ i.hint }}</span>
        <span class="label w-14 shrink-0 text-right">{{ i.group }}</span>
      </li>
    </ul>
  </dialog>
</template>

<style scoped>
@reference '../style.css';
.item {
  @apply flex h-9 items-center gap-2.5 rounded-lg px-2.5;
}
.item.on {
  background: var(--active);
}
</style>
