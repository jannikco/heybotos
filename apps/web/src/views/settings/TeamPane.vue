<script setup lang="ts">
// Who the manager can hand work to. Each member opens to their own page; here you see them all,
// take one off duty, and add a new one.
import { computed, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { StaffView } from '@heybotos/protocol'
import { api, type ApiError } from '../../api'
import AgentFace from '../../components/AgentFace.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { ENGINE_NAME } from '../../format'
import { saved } from '../../settings'
import { loadStaff, state } from '../../store'

const team = computed(() => state.staff.filter((m) => !m.isChief).sort((a, b) => Number(b.active) - Number(a.active)))
const member = reactive({ name: '', title: '' })
const note = ref('')
const bad = ref('')
const adding = ref(false)

// The face a new member will get: the daemon derives it from the name the same way.
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'member'
const draftName = computed(() => member.name.replace(/\s+/g, ' ').trim().slice(0, 40))
const draftHue = computed(() => [...draftName.value].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7))

const doing = (m: StaffView) => (!m.active ? 'Off duty' : m.currentTaskId ? 'Working now' : m.stats.open ? `${m.stats.open} waiting` : m.stats.done ? `${m.stats.done} done` : 'Nothing yet')

async function duty(m: StaffView, active: boolean): Promise<void> {
  bad.value = ''
  note.value = ''
  try {
    await api(`/api/staff/${m.id}`, { method: 'PUT', body: { active } })
    await loadStaff()
    saved()
  } catch (e) {
    bad.value = (e as ApiError).message
  }
}

async function add(): Promise<void> {
  bad.value = ''
  note.value = ''
  adding.value = true
  try {
    await api('/api/staff', { method: 'POST', body: { name: member.name, title: member.title } })
    await loadStaff()
    note.value = `${draftName.value} joined the team. Open them to shape how they work.`
    member.name = ''
    member.title = ''
  } catch (e) {
    bad.value = (e as ApiError).message
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div>
    <h2 class="pane-title">Team</h2>
    <p class="pane-lede">The people the manager hands work to. Each has a role, a way of working and a memory of their own.</p>

    <section class="set-panel mt-7" aria-label="Team members">
      <ul>
        <li v-for="m in team" :key="m.id" class="set-row keep">
          <RouterLink :to="`/team/${m.id}`" class="who" :aria-label="`${m.name}, ${m.title}`">
            <AgentFace :seed="m.id" :hue="m.hue" :size="36" :state="!m.active ? 'off' : m.currentTaskId ? 'working' : 'idle'" />
            <span class="min-w-0">
              <span class="block truncate font-semibold" :class="m.active ? '' : 'text-ink-3'">{{ m.name }}</span>
              <span class="text-ink-2 block truncate text-xs">{{ m.title }}</span>
            </span>
          </RouterLink>
          <div class="flex items-center gap-4">
            <span class="text-ink-3 max-sm:hidden">{{ m.engine === 'auto' ? 'Any engine' : ENGINE_NAME[m.engine] }}</span>
            <span class="tabular w-24 text-right max-sm:hidden" :class="m.active && m.currentTaskId ? 'text-signal' : 'text-ink-2'">{{ doing(m) }}</span>
            <UiSwitch :model-value="m.active" :label="`${m.name} takes work`" @update:model-value="(on) => duty(m, on)" />
          </div>
        </li>
      </ul>
      <form class="new" aria-label="Add a team member" @submit.prevent="add">
        <AgentFace :seed="slug(draftName)" :hue="draftHue" :size="36" :state="draftName ? 'idle' : 'off'" />
        <input v-model="member.name" class="field" placeholder="Name" aria-label="New member's name" maxlength="40" required autocomplete="off" />
        <input v-model="member.title" class="field" placeholder="Role, like Designer" aria-label="Role" maxlength="60" required autocomplete="off" />
        <button class="btn btn-primary" :disabled="adding">Add to the team</button>
      </form>
    </section>
    <p class="mt-3 min-h-5 px-1"><span class="text-ok" role="status">{{ note }}</span><span class="text-bad" role="alert">{{ bad }}</span></p>
  </div>
</template>

<style scoped>
.who {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  margin: -0.35rem -0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: 8px;
}
.who:hover {
  background: var(--hover);
}
.new {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 1rem;
  border-top: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--sunken) 55%, transparent);
}
@media (max-width: 34rem) {
  .new {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .new .btn {
    grid-column: 1 / -1;
  }
}
</style>
