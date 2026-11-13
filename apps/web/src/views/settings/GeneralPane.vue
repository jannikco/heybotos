<script setup lang="ts">
// How HeyBotOS looks, how much it runs at once, and where your projects live.
import { computed } from 'vue'
import SettingGroup from '../../components/ui/SettingGroup.vue'
import SettingRow from '../../components/ui/SettingRow.vue'
import UiList from '../../components/ui/UiList.vue'
import UiStepper from '../../components/ui/UiStepper.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { change, saving, settings } from '../../settings'
import { working } from '../../store'
import { setTheme, themeChoice, type ThemeChoice } from '../../theme'
import UpdatePanel from './UpdatePanel.vue'

const g = computed(() => settings.value!.general)
const workers = computed({ get: () => g.value.maxWorkers, set: (n) => void change('workers', { general: { maxWorkers: n } }) })
const notify = computed({ get: () => g.value.notifications, set: (on) => void change('notify', { general: { notifications: on } }) })
const busy = computed(() => working.value.length)
const look = computed({ get: () => themeChoice.value, set: (c) => setTheme(c) })

const LOOKS: Array<{ value: ThemeChoice; name: string }> = [
  { value: 'dark', name: 'Dark' },
  { value: 'light', name: 'Light' },
  { value: 'system', name: 'Match the system' },
]

const addRoot = (path: string) => change('roots', { general: { projectRoots: [...g.value.projectRoots, path] } })
const removeRoot = (path: string) => change('roots', { general: { projectRoots: g.value.projectRoots.filter((r) => r !== path) } })

// Inside the desktop app the Mac's own folder chooser is there to use.
const desktop = window.heybotosDesktop
async function choose(): Promise<void> {
  // An app that was open while it was updated may not answer yet; typing the path still works.
  const path = await desktop?.pickFolder?.().catch(() => null)
  if (path && !g.value.projectRoots.includes(path)) await addRoot(path)
}
</script>

<template>
  <div>
    <h2 class="pane-title">General</h2>
    <p class="pane-lede">How HeyBotOS looks, how much it runs at once, and where it finds your projects.</p>

    <SettingGroup title="Look">
      <div class="grid grid-cols-3 gap-4 p-4 max-sm:grid-cols-2" role="radiogroup" aria-label="Look">
        <label v-for="l in LOOKS" :key="l.value" class="look" :class="{ on: look === l.value }">
          <input v-model="look" type="radio" name="look" class="sr-only" :value="l.value" />
          <span class="shot" aria-hidden="true">
            <span v-if="l.value !== 'light'" class="face dark"><i class="side"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="pill"></i></span>
            <span v-if="l.value !== 'dark'" class="face light" :class="{ half: l.value === 'system' }"><i class="side"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="pill"></i></span>
          </span>
          <span class="mt-2 flex items-center gap-2"><span class="radio-dot"></span>{{ l.name }}</span>
        </label>
      </div>
    </SettingGroup>

    <SettingGroup label="Running">
      <SettingRow title="Workers at once" :hint="`How many workers may run at the same time. The rest wait for a free slot. ${busy ? `${busy} working right now.` : 'Nobody is working right now.'}`" :error="saving.errors.workers">
        <span class="flex gap-1 max-sm:hidden" aria-hidden="true"><i v-for="n in 12" :key="n" class="slot" :class="{ on: n <= workers, busy: n <= busy }"></i></span>
        <UiStepper v-model="workers" label="Workers at once" :min="1" :max="12" />
      </SettingRow>
      <SettingRow title="Notifications" hint="Tell me when something lands in the inbox." :error="saving.errors.notify" class="keep">
        <UiSwitch v-model="notify" label="Notifications" />
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="Project folders" hint="HeyBotOS looks one level into these folders and lists what it finds as your projects.">
      <UiList label="Project folders" :items="g.projectRoots" placeholder="~/Code" add-label="Add folder" :add="addRoot" :remove="removeRoot" mono>
        <template #icon>
          <svg viewBox="0 0 16 16" class="text-ink-3 size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h4L7.5 6H14v6.5H2z" /></svg>
        </template>
        <template v-if="desktop?.pickFolder" #actions>
          <button type="button" class="btn btn-ghost" @click="choose">Choose…</button>
        </template>
      </UiList>
      <p v-if="saving.errors.roots" class="set-error px-4 pb-3" role="alert">{{ saving.errors.roots }}</p>
    </SettingGroup>

    <UpdatePanel />
  </div>
</template>

<style scoped>
.look {
  display: block;
  font-weight: 500;
  color: var(--ink-2);
}
.look.on {
  color: var(--ink);
}
.shot {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 8 / 5;
  border-radius: 9px;
  overflow: hidden;
  box-shadow: 0 0 0 1px var(--line);
  transition: box-shadow 0.14s;
}
.look:hover .shot {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 30%, transparent);
}
.look.on .shot {
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 4px var(--signal);
}
.look:has(input:focus-visible) .shot {
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 4px var(--signal),
    0 0 0 7px color-mix(in srgb, var(--signal) 30%, transparent);
}
/* A small drawing of the app: the sidebar, a few lines of talk, the accent. */
.face {
  position: absolute;
  inset: 0;
}
.face.dark {
  --p: #0a102a;
  --s: #141c3f;
  --t: rgba(180, 195, 255, 0.26);
  --a: #7391ff;
}
.face.light {
  --p: #f4f5fb;
  --s: #ffffff;
  --t: rgba(10, 16, 42, 0.2);
  --a: #315dfb;
}
.face {
  background: var(--p);
}
.face.half {
  clip-path: polygon(62% 0, 100% 0, 100% 100%, 38% 100%);
}
.face i {
  position: absolute;
  border-radius: 999px;
  background: var(--t);
}
.face .side {
  left: 0;
  top: 0;
  bottom: 0;
  width: 30%;
  border-radius: 0;
  background: var(--s);
  box-shadow: 1px 0 0 var(--t);
  opacity: 0.9;
}
.face .l1 {
  left: 38%;
  top: 22%;
  width: 34%;
  height: 7%;
}
.face .l2 {
  left: 38%;
  top: 38%;
  width: 50%;
  height: 7%;
  opacity: 0.6;
}
.face .l3 {
  left: 38%;
  top: 54%;
  width: 42%;
  height: 7%;
  opacity: 0.6;
}
.face .pill {
  right: 9%;
  bottom: 12%;
  width: 22%;
  height: 13%;
  background: var(--a);
}
.radio-dot {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  border: 1.5px solid color-mix(in srgb, var(--ink-3) 80%, transparent);
  display: inline-grid;
  place-content: center;
}
.look.on .radio-dot {
  border-color: var(--signal);
  background: var(--signal);
}
.look.on .radio-dot::after {
  content: '';
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background: #fff;
}
.slot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: var(--active);
  transition:
    background-color 0.2s,
    transform 0.2s cubic-bezier(0.3, 0.7, 0.3, 1.5);
}
.slot.on {
  background: var(--ink-3);
}
/* A slot somebody is working in right now. */
.slot.busy {
  background: var(--signal);
  color: var(--signal);
  transform: scale(1.2);
  animation: breathe 1.8s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .slot.busy {
    animation: none;
  }
}
</style>
