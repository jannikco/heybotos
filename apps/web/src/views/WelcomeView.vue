<script setup lang="ts">
// The first thing a new installation shows: which of the three command-line tools are ready to
// work, and where the owner's projects are. Everything here can be changed later in Settings.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import BrandMark from '../components/brand/BrandMark.vue'
import BrandWordmark from '../components/brand/BrandWordmark.vue'
import UiList from '../components/ui/UiList.vue'
import { ENGINE_NAME } from '../format'
import { change, loadSettings, saving, settings } from '../settings'
import { boot, loadProjects, refreshHealth, state } from '../store'

const router = useRouter()
const checking = ref(false)
const starting = ref(false)

onMounted(async () => {
  if (!state.me) await boot()
  await loadSettings().catch(() => {})
  void refreshHealth().catch(() => {})
})

const ready = computed(() => (state.health ?? []).filter((e) => e.loggedIn).length)
const roots = computed(() => settings.value?.general.projectRoots ?? [])
const found = computed(() => state.projects.filter((p) => p.kind === 'code' && !p.missing).length)

async function check(): Promise<void> {
  checking.value = true
  try {
    await refreshHealth(true)
  } finally {
    checking.value = false
  }
}

const addRoot = async (path: string) => (await change('roots', { general: { projectRoots: [...roots.value, path] } })) && (await loadProjects().then(() => true))
const removeRoot = (path: string) => change('roots', { general: { projectRoots: roots.value.filter((r) => r !== path) } })
const desktop = (window as unknown as { heybotosDesktop?: { pickFolder?: () => Promise<string | null> } }).heybotosDesktop
async function choose(): Promise<void> {
  const path = await desktop?.pickFolder?.().catch(() => null)
  if (path && !roots.value.includes(path)) await addRoot(path)
}

/** How to get a tool that is missing or signed out, in one line. */
const HOW: Record<string, { install: string; signIn: string }> = {
  claude: { install: 'Install Claude Code, then run "claude" once and sign in.', signIn: 'Run "claude auth login" in a terminal.' },
  codex: { install: 'Install the Codex CLI, then run "codex login".', signIn: 'Run "codex login" in a terminal.' },
  grok: { install: 'Install Grok Build, then run "grok login".', signIn: 'Run "grok login" in a terminal.' },
}

async function start(): Promise<void> {
  starting.value = true
  try {
    await api('/api/welcome', { method: 'POST' })
    if (state.me) state.me.welcomed = true
    await router.replace('/t/chief')
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <main class="welcome">
    <div class="inner">
      <header class="flex items-center gap-4">
        <BrandMark :size="72" :state="ready ? 'working' : 'idle'" />
        <div>
          <BrandWordmark :height="30" />
          <p class="text-ink-2 mt-2 text-lg">One manager you talk to. A team of agents that does the work.</p>
        </div>
      </header>

      <section class="mt-10" aria-labelledby="w-engines">
        <div class="flex items-baseline gap-3">
          <h2 id="w-engines" class="text-xl">The engines</h2>
          <span class="flex-1"></span>
          <button class="btn btn-ghost" :disabled="checking" @click="check">{{ checking ? 'Checking' : 'Check again' }}</button>
        </div>
        <p class="text-ink-2 mt-1 max-w-[62ch]">HeyBotOS runs the official command-line tools with your own subscriptions; it has no account or key of its own. One is enough to start. With more, work is spread across them.</p>
        <p v-if="!state.health" class="text-ink-3 mt-4">Looking for the tools…</p>
        <ul v-else class="set-panel mt-4">
          <li v-for="e in state.health" :key="e.engine" class="set-row keep">
            <div class="min-w-0">
              <p class="set-title">{{ ENGINE_NAME[e.engine] }}</p>
              <p class="set-hint">{{ e.loggedIn ? e.detail : e.found ? HOW[e.engine]!.signIn : HOW[e.engine]!.install }}</p>
            </div>
            <p class="text-sm font-semibold" :class="e.loggedIn ? 'text-ok' : 'text-ink-3'">{{ e.loggedIn ? 'Ready' : e.found ? 'Needs a sign-in' : 'Not installed' }}</p>
          </li>
        </ul>
      </section>

      <section class="mt-9" aria-labelledby="w-projects">
        <h2 id="w-projects" class="text-xl">Your projects</h2>
        <p class="text-ink-2 mt-1 max-w-[62ch]">Every folder directly inside these becomes a project the team can work in. {{ found ? `${found} found so far.` : 'None found yet.' }}</p>
        <div class="set-panel mt-4">
          <UiList label="Project folders" :items="roots" placeholder="~/Code" add-label="Add folder" :add="addRoot" :remove="removeRoot" mono empty="No folder yet. Add the one your projects are in.">
            <template v-if="desktop?.pickFolder" #actions><button type="button" class="btn" @click="choose">Choose…</button></template>
          </UiList>
          <p v-if="saving.errors.roots" class="set-error px-4 pb-3" role="alert">{{ saving.errors.roots }}</p>
        </div>
      </section>

      <footer class="mt-10 flex items-center gap-4">
        <button class="btn btn-primary start" :disabled="starting" @click="start">Meet your team</button>
        <p class="text-ink-3 text-sm">{{ ready ? 'All of this can be changed later in Settings.' : 'You can go on without an engine and look around; workers start once one is ready.' }}</p>
      </footer>
    </div>
  </main>
</template>

<style scoped>
.welcome {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 3rem 1.25rem;
  background:
    radial-gradient(60rem 30rem at 15% -10%, color-mix(in srgb, #8156f7 16%, transparent), transparent 70%),
    radial-gradient(50rem 28rem at 110% 10%, color-mix(in srgb, #f459b4 9%, transparent), transparent 70%), var(--paper);
}
.inner {
  width: min(42rem, 100%);
}
.start {
  height: 2.5rem;
  padding: 0 1.25rem;
  font-size: 0.9375rem;
  border-radius: 999px;
}
</style>
