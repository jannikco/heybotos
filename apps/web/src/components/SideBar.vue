<script setup lang="ts">
// The left side: who you can talk to. The manager and the team on top, then one conversation per
// project with what is happening there right now.
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ThreadView } from '@heybotos/protocol'
import { clock, dayLabel } from '../format'
import { command, hueOf, inboxCount, jobs, managerName, staffById, state } from '../store'
import AgentFace from './AgentFace.vue'
import BrandWordmark from './brand/BrandWordmark.vue'

const route = useRoute()
const current = computed(() => (route.name === 'thread' ? String(route.params.thread) : null))
const member = computed(() => (route.name === 'member' ? String(route.params.id) : null))

const chief = computed(() => state.threads.find((t) => t.id === 'chief'))
const projects = computed(() => state.threads.filter((t) => t.id !== 'chief'))
const team = computed(() => state.staff.filter((s) => !s.isChief && s.active))

/** What is going on in a conversation right now, if a worker is out there. */
function live(t: ThreadView): string | null {
  if (t.id === 'chief') return state.chat.activeRunId && state.chat.activeThread === 'chief' ? 'Working on it' : null
  if (state.chat.activeRunId && state.chat.activeThread === t.id) return `${managerName.value} is answering`
  const job = jobs.value.find((j) => j.state === 'working' && j.task?.project === t.id)
  if (!job) return null
  return `${job.task?.assigneeName ?? 'A worker'}: ${job.run?.activity ?? 'starting'}`
}
function when(ts: number): string {
  if (!ts) return ''
  const day = dayLabel(ts, state.now)
  return day === 'Today' ? clock(ts) : day === 'Yesterday' ? 'Yesterday' : new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
}
const faceState = (t: ThreadView) => (t.needsYou ? 'needs' : t.working || (state.chat.activeRunId && state.chat.activeThread === t.id) ? 'working' : 'idle')
</script>

<template>
  <aside class="side border-line-soft flex h-dvh min-h-0 flex-col border-r" aria-label="Conversations">
    <div class="side-top flex items-center gap-2 px-3 pb-2 pt-3">
      <span class="flex-1 pl-1"><BrandWordmark :height="17" /></span>
      <button class="round" aria-label="Find or run anything" title="Find or run anything (⌘K)" @click="command('palette')">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></svg>
      </button>
      <button class="round" aria-label="New task" title="New task (C)" @click="command('new-task')">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>
      </button>
    </div>

    <!-- The people: the manager first, then the team. A blue mark means working, amber means it needs you. -->
    <nav class="people grid grid-cols-4 gap-x-1 gap-y-0.5 px-2 pb-3 pt-1" aria-label="Your team">
      <RouterLink to="/t/chief" class="person" :class="current === 'chief' ? 'on' : ''" :aria-label="`${managerName}, leads the team`">
        <AgentFace seed="chief" :hue="250" :size="48" chief :state="state.chat.activeRunId ? 'working' : chief?.unread ? 'needs' : 'idle'" />
        <span class="name">{{ managerName }}</span>
      </RouterLink>
      <RouterLink v-for="m in team" :key="m.id" :to="`/team/${m.id}`" class="person" :class="member === m.id ? 'on' : ''" :aria-label="`${m.name}, ${m.title}${m.currentTaskId ? ', working' : ''}`">
        <AgentFace :seed="m.id" :hue="m.hue" :size="48" :state="m.currentTaskId ? 'working' : 'idle'" />
        <span class="name">{{ m.name }}</span>
      </RouterLink>
    </nav>

    <ul class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <li v-if="!projects.length" class="text-ink-3 px-3 py-6 text-sm leading-relaxed">
        Projects show up here as soon as something happens in them. Ask {{ managerName }} for something, or press <span class="kbd">C</span> to give a task yourself.
      </li>
      <li v-for="t in projects" :key="t.id">
        <RouterLink :to="`/t/${t.id}`" class="thread" :class="current === t.id ? 'on' : ''">
          <span class="relative shrink-0">
            <AgentFace :seed="t.id" :hue="hueOf(t.id)" :size="40" :state="faceState(t)" />
            <!-- who from the team is out there right now -->
            <span v-if="t.workers.length" class="absolute -bottom-1 -right-1.5 flex">
              <AgentFace v-for="w in t.workers.slice(0, 2)" :key="w" :seed="w" :hue="staffById(w)?.hue ?? 220" :size="18" :badge="false" class="worker-face -ml-1.5" />
            </span>
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="truncate text-lg font-medium leading-tight">{{ t.name }}</span>
              <span class="telemetry ml-auto shrink-0">{{ when(t.lastAt) }}</span>
            </span>
            <span class="flex items-center gap-2">
              <span v-if="live(t)" class="working-text min-w-0 flex-1 truncate">{{ live(t) }}</span>
              <span v-else class="min-w-0 flex-1 truncate" :class="t.needsYou ? 'text-wait' : 'text-ink-3'">{{ t.lastText || 'Nothing yet' }}</span>
              <span v-if="t.unread" class="bg-signal size-2 shrink-0 rounded-full" :aria-label="`${t.unread} new`"></span>
            </span>
          </span>
        </RouterLink>
      </li>
    </ul>

    <nav class="border-line-soft flex items-center gap-1 border-t px-2 py-2" aria-label="More">
      <RouterLink to="/inbox" class="foot" active-class="on" title="Inbox">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M2 9.5 4 3h8l2 6.5V13H2V9.5Zm0 0h3.6l.9 1.6h3l.9-1.6H14" /></svg>
        <span>Inbox</span>
        <span v-if="inboxCount" class="bg-wait text-paper tabular rounded-full px-1.5 text-[0.6875rem] font-bold leading-4">{{ inboxCount }}</span>
      </RouterLink>
      <RouterLink to="/board" class="foot" active-class="on" title="Board">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z" /></svg>
        <span>Board</span>
      </RouterLink>
      <RouterLink to="/projects" class="foot" active-class="on" title="All projects">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M2 4.5h4L7.5 6H14v6.5H2z" /></svg>
        <span>Projects</span>
      </RouterLink>
      <RouterLink to="/settings" class="foot ml-auto" active-class="on" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M3 5h6M12 5h1M3 11h1M7 11h6" /><circle cx="10.5" cy="5" r="1.5" /><circle cx="5.5" cy="11" r="1.5" /></svg>
      </RouterLink>
    </nav>
  </aside>
</template>

<style scoped>
@reference '../style.css';
.side {
  background: color-mix(in srgb, var(--surface) 55%, var(--paper));
}
.round {
  @apply text-ink-2 grid size-8 place-items-center rounded-full;
  background: var(--sunken);
}
.round:hover {
  @apply text-ink;
  background: var(--active);
}
.people {
  scrollbar-width: none;
}
.person {
  @apply flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2;
}
.person:hover {
  background: var(--hover);
}
.person.on {
  background: var(--active);
}
.person .name {
  @apply text-ink-2 w-full truncate text-center text-xs font-medium;
}
.person.on .name {
  @apply text-ink;
}
.thread {
  @apply flex items-center gap-3 rounded-xl px-2.5 py-2.5;
}
.thread:hover {
  background: var(--hover);
}
.thread.on {
  background: var(--active);
}
.worker-face {
  filter: drop-shadow(0 0 0 2px var(--paper));
}
.foot {
  @apply text-ink-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium;
}
.foot:hover,
.foot.on {
  @apply text-ink;
  background: var(--hover);
}
</style>
