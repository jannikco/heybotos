<script setup lang="ts">
// Which version this is, whether there is a newer one, and the way to get it. The service finds,
// fetches and checks the new version; the desktop app replaces itself with it and opens again.
import { computed, ref } from 'vue'
import type { UpdateState } from '@heybotos/protocol'
import { api, ApiError } from '../../api'
import Prose from '../../components/Prose.vue'
import SettingGroup from '../../components/ui/SettingGroup.vue'
import SettingRow from '../../components/ui/SettingRow.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { ago } from '../../format'
import { change, saving, settings } from '../../settings'
import { state, working } from '../../store'

const u = computed(() => state.update)
const auto = computed({ get: () => settings.value!.general.autoUpdate, set: (on) => void change('autoUpdate', { general: { autoUpdate: on } }) })
const desktop = window.heybotosDesktop
/** The app has been asked to install: it fetches if needed, then closes and opens again. */
const installing = ref(false)
const problem = ref('')
const copied = ref(false)

const version = computed(() => `${state.me?.version ?? u.value?.current ?? ''}${state.me?.stage ? ` ${state.me.stage}` : ''}`)
const percent = computed(() => Math.round((u.value?.progress ?? 0) * 100))
const busy = computed(() => working.value.length)
/** The command a person runs themselves, when the app cannot replace itself. */
const command = computed(() => /: (sudo .+|brew .+)$/.exec(u.value?.hint ?? '')?.[1] ?? '')

async function ask(path: string): Promise<void> {
  problem.value = ''
  try {
    state.update = await api<UpdateState>(path, { method: 'POST' })
  } catch (e) {
    problem.value = (e as ApiError).message
  }
}
const check = () => ask('/api/update/check')
const download = () => ask('/api/update/download')

async function install(): Promise<void> {
  problem.value = ''
  installing.value = true
  const res = await desktop?.installUpdate?.().catch((e: Error) => ({ ok: false, problem: e.message }))
  // On success the app closes within a moment; anything else is said here.
  if (!res?.ok) {
    installing.value = false
    problem.value = res?.problem ?? 'This window cannot install updates. Open the HeyBotOS app and update from there.'
  }
}

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(command.value).catch(() => {})
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <SettingGroup v-if="u" title="Version" :class="{ fresh: u.latest }">
    <div class="now" :class="{ has: u.latest }">
      <div class="min-w-0 flex-1">
        <template v-if="u.latest">
          <p class="headline">Version {{ u.latest.version }} is {{ u.status === 'ready' && u.how === 'app' ? 'ready to install' : 'available' }}</p>
          <p class="set-hint">You have {{ version }}.</p>
        </template>
        <template v-else>
          <p class="headline">HeyBotOS {{ version }}</p>
          <p class="set-hint" aria-live="polite">
            <template v-if="u.how === 'source'">{{ u.hint }}</template>
            <template v-else-if="u.status === 'checking'">Looking for a newer version…</template>
            <template v-else-if="u.status === 'failed'">{{ u.problem }}</template>
            <template v-else-if="u.checkedAt">This is the newest version. Looked {{ ago(u.checkedAt, state.now) }}.</template>
            <template v-else>Not looked for a newer version yet.</template>
          </p>
        </template>
      </div>

      <template v-if="u.how !== 'source'">
        <button v-if="!u.latest" type="button" class="btn" :disabled="u.status === 'checking'" @click="check">{{ u.status === 'checking' ? 'Looking' : 'Look now' }}</button>
        <template v-else-if="u.how === 'app'">
          <button v-if="desktop?.installUpdate" type="button" class="btn btn-primary" :disabled="installing || u.status === 'downloading'" @click="install">
            {{ installing || u.status === 'downloading' ? (u.status === 'downloading' ? `Fetching ${percent}%` : 'Installing') : 'Update and restart' }}
          </button>
        </template>
        <button v-else-if="!command && u.status !== 'ready'" type="button" class="btn btn-primary" :disabled="u.status === 'downloading'" @click="download">{{ u.status === 'downloading' ? `Fetching ${percent}%` : 'Download' }}</button>
      </template>
    </div>

    <div v-if="u.status === 'downloading'" class="bar" role="progressbar" aria-label="Fetching the new version" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }"></i></div>

    <div v-if="u.latest" class="more">
      <p v-if="installing && u.status !== 'downloading'" class="note" role="status">HeyBotOS closes, replaces itself and opens again. This takes a moment.</p>
      <p v-else-if="u.how === 'app' && !desktop?.installUpdate" class="note">Open the HeyBotOS app and choose "Update and restart" there: a browser window cannot replace the app.</p>
      <template v-else-if="u.how === 'package'">
        <p class="note">{{ command ? u.hint!.slice(0, u.hint!.length - command.length).trim() : u.hint }}</p>
        <p v-if="command" class="cmd"><code>{{ command }}</code><button type="button" class="btn btn-ghost" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button></p>
      </template>
      <p v-if="u.how === 'app' && busy && !installing" class="note">{{ busy }} worker{{ busy === 1 ? ' is' : 's are' }} running. They keep going through the update; a turn the manager is in the middle of is cut off.</p>
      <p v-if="problem || (u.status === 'failed' && u.problem)" class="set-error" role="alert">{{ problem || u.problem }}</p>
      <details v-if="u.latest.notes" class="notes">
        <summary>What is new in {{ u.latest.version }}</summary>
        <Prose :text="u.latest.notes" />
        <a v-if="u.latest.page" :href="u.latest.page" target="_blank" rel="noopener noreferrer" class="text-ink-2 mt-2 inline-block text-sm underline">Read more</a>
      </details>
    </div>

    <SettingRow v-if="u.how !== 'source'" title="Look for updates" hint="HeyBotOS asks GitHub now and then whether there is a newer version. Nothing is installed until you say so." :error="saving.errors.autoUpdate" class="keep">
      <UiSwitch v-model="auto" label="Look for updates" />
    </SettingRow>
  </SettingGroup>
</template>

<style scoped>
/* When there is something new the panel carries the brand's colours: it is the one thing on the page asking for a click. */
.fresh :deep(.set-panel) {
  border-color: transparent;
  background:
    linear-gradient(var(--surface), var(--surface)) padding-box,
    var(--brand) border-box;
  box-shadow: 0 10px 40px color-mix(in srgb, #8156f7 22%, transparent);
}
.now {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.9rem 1rem;
}
.headline {
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.now.has .headline {
  font-size: 1.0625rem;
}
.bar {
  height: 3px;
  background: var(--sunken);
}
.bar i {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.3s ease-out;
}
.more {
  display: grid;
  gap: 0.55rem;
  padding: 0 1rem 0.9rem;
}
.note {
  max-width: 62ch;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--ink-2);
}
.cmd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.4rem 0.35rem 0.75rem;
  border-radius: 0.5rem;
  background: var(--sunken);
}
.cmd code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  user-select: all;
}
.notes summary {
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 550;
  color: var(--ink-2);
}
.notes summary:hover {
  color: var(--ink);
}
.notes[open] summary {
  margin-bottom: 0.5rem;
}
</style>
