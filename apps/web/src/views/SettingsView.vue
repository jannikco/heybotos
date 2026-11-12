<script setup lang="ts">
// Settings: a rail of sections on the left, one section at a time on the right. Every change is
// saved as it is made; the word beside the title says so.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ApiError } from '../api'
import AgentFace from '../components/AgentFace.vue'
import { clearErrors, connectors, loadConnectors, loadSettings, saving, settings } from '../settings'
import { managerName, refreshHealth, state } from '../store'
import ConnectorsPane from './settings/ConnectorsPane.vue'
import EnginesPane from './settings/EnginesPane.vue'
import GeneralPane from './settings/GeneralPane.vue'
import ManagerPane from './settings/ManagerPane.vue'
import SafetyPane from './settings/SafetyPane.vue'
import TeamPane from './settings/TeamPane.vue'

const route = useRoute()
const PANES = { general: GeneralPane, manager: ManagerPane, team: TeamPane, engines: EnginesPane, connectors: ConnectorsPane, safety: SafetyPane }
type Section = keyof typeof PANES
const section = computed<Section>(() => (String(route.params.section ?? '') in PANES ? (route.params.section as Section) : 'general'))
const problem = ref('')

onMounted(() => {
  loadSettings().catch((e) => (problem.value = (e as ApiError).message))
  void loadConnectors().catch(() => {})
  void refreshHealth().catch(() => {})
})
watch(section, clearErrors)

// On a narrow window the rail is a strip that scrolls sideways: keep the chosen section in view.
const rail = ref<HTMLElement | null>(null)
watch(
  section,
  () => void nextTick(() => rail.value?.querySelector('.item.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })),
  { flush: 'post', immediate: true },
)

// What the rail says beside a section's name, where there is something to say.
const teamSize = computed(() => state.staff.filter((m) => !m.isChief && m.active).length)
const needSignIn = computed(() => connectors.value.filter((c) => c.enabled && c.needsSignIn).length)
const enginesDown = computed(() => (state.health ?? []).filter((h) => !h.loggedIn).length)
</script>

<template>
  <div class="flex h-dvh min-w-0 flex-col">
    <header class="viewbar">
      <RouterLink to="/list" class="btn btn-ghost md:hidden" aria-label="All conversations">‹</RouterLink>
      <h1>Settings</h1>
      <span class="flex-1"></span>
      <span class="saved" :class="{ on: saving.mark }" role="status" aria-label="Saving">
        <svg v-if="saving.mark" viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 6.4 2.3 2.3 4.7-5.2" /></svg>{{ saving.mark }}
      </span>
    </header>

    <div class="min-h-0 flex-1 md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] max-md:flex max-md:flex-col">
      <nav ref="rail" class="rail" aria-label="Settings">
        <RouterLink to="/settings/general" class="item" :class="{ on: section === 'general' }" :aria-current="section === 'general' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M3 5h6M12 5h1M3 11h1M7 11h6" /><circle cx="10.5" cy="5" r="1.5" /><circle cx="5.5" cy="11" r="1.5" /></svg>
          <span class="name">General</span>
        </RouterLink>
        <RouterLink to="/settings/manager" class="item" :class="{ on: section === 'manager' }" :aria-current="section === 'manager' ? 'page' : undefined">
          <span class="ic grid place-items-center"><AgentFace seed="chief" :hue="250" chief :size="17" :badge="false" /></span>
          <span class="name">{{ managerName }}</span>
        </RouterLink>
        <RouterLink to="/settings/team" class="item" :class="{ on: section === 'team' }" :aria-current="section === 'team' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c.3-2.3 1.9-3.6 4-3.6s3.7 1.3 4 3.6M10.6 3.6a2.2 2.2 0 0 1 0 3.9M12 9.8c1.2.5 1.9 1.6 2.1 3.2" /></svg>
          <span class="name">Team</span>
          <span v-if="teamSize" class="count tabular" :aria-label="`${teamSize} members`">{{ teamSize }}</span>
        </RouterLink>
        <RouterLink to="/settings/engines" class="item" :class="{ on: section === 'engines' }" :aria-current="section === 'engines' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" /></svg>
          <span class="name">Engines</span>
          <span v-if="enginesDown" class="dot bg-bad" role="img" :aria-label="`${enginesDown} not signed in`"></span>
        </RouterLink>
        <RouterLink to="/settings/connectors" class="item" :class="{ on: section === 'connectors' }" :aria-current="section === 'connectors' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5ZM8 11v3" /></svg>
          <span class="name">Connectors</span>
          <span v-if="needSignIn" class="dot bg-wait" role="img" :aria-label="`${needSignIn} need a sign-in`"></span>
        </RouterLink>
        <RouterLink to="/settings/safety" class="item" :class="{ on: section === 'safety' }" :aria-current="section === 'safety' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 3 4v3.6c0 3 2 5.3 5 6.4 3-1.1 5-3.4 5-6.400V4L8 2Z" /><path d="m6 8 1.5 1.500L10.2 6.5" /></svg>
          <span class="name">Safety</span>
        </RouterLink>

        <span class="sep" aria-hidden="true"></span>

        <RouterLink to="/routines" class="item">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.200l2 1.3" /></svg>
          <span class="name">Routines</span>
        </RouterLink>
        <RouterLink to="/usage" class="item">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13V8M8 13V3M13 13V6" /></svg>
          <span class="name">Usage</span>
        </RouterLink>
        <RouterLink to="/health" class="item">
          <svg viewBox="0 0 16 16" class="ic" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8.500h3l1.5-4 3 7.5 1.5-3.500h4" /></svg>
          <span class="name">Health</span>
        </RouterLink>

        <p v-if="settings" class="telemetry about">Data in {{ settings.paths.home }}<br />HeyBotOS {{ state.me?.version }}{{ state.me?.stage ? ` ${state.me.stage}` : '' }}</p>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="pane">
          <p v-if="problem" class="bg-bad-soft text-bad rounded-lg px-3.5 py-2.5" role="alert">{{ problem }}</p>
          <component :is="PANES[section]" v-else-if="settings" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.saved {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ok);
  opacity: 0;
  transition: opacity 0.25s;
}
.saved.on {
  opacity: 1;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.75rem 0.5rem;
  border-right: 1px solid var(--line-soft);
  overflow-y: auto;
}
.item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  height: 1.9rem;
  padding: 0 0.6rem;
  border-radius: 7px;
  font-weight: 500;
  color: var(--ink-2);
  white-space: nowrap;
}
.item:hover {
  background: var(--hover);
  color: var(--ink);
}
.item.on {
  background: var(--active);
  color: var(--ink);
}
.ic {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
.name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-size: 0.6875rem;
  color: var(--ink-3);
}
.dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
}
.sep {
  height: 1px;
  margin: 0.5rem 0.6rem;
  background: var(--line-soft);
  flex-shrink: 0;
}
.about {
  margin-top: auto;
  padding: 1rem 0.6rem 0.25rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.pane {
  max-width: 47rem;
  padding: 2rem 2rem 5rem;
  margin-inline: auto;
}

/* On a narrow window the rail lies down: a strip of tabs that scrolls sideways. */
@media (max-width: 47.99rem) {
  .rail {
    flex-direction: row;
    flex-shrink: 0;
    gap: 2px;
    padding: 0.4rem 0.5rem;
    border-right: 0;
    border-bottom: 1px solid var(--line-soft);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .name {
    flex: none;
    overflow: visible;
  }
  .sep {
    width: 1px;
    height: auto;
    margin: 0.3rem 0.3rem;
  }
  .about {
    display: none;
  }
  .pane {
    padding: 1.25rem 1rem 4rem;
    margin-left: 0;
  }
}
</style>
