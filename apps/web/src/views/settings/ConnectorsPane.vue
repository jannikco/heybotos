<script setup lang="ts">
// HeyBotOS's own connectors: set one up here once and workers on every engine reach it through HeyBotOS.
// Opened, a connector shows what it offers; anything that changes something asks first, unless you
// allow that one tool here.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { ConnectorView } from '@heybotos/protocol'
import { api, type ApiError } from '../../api'
import StatusDot from '../../components/StatusDot.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import type { Tone } from '../../format'
import { change, connectors as list, loadConnectors, putConnector, saving, settings } from '../../settings'
import { hueOf } from '../../store'

const open = ref<string | null>(null)
const find = ref('')
const busy = reactive<Record<string, boolean>>({})
const note = ref('')
const bad = ref('')

onMounted(() => void loadConnectors().catch((e) => (bad.value = (e as ApiError).message)))

// A sign-in happens in the browser; when the owner comes back, show what came of it.
const waitingFor = ref<string | null>(null)
function back(): void {
  if (waitingFor.value) void loadConnectors().then(() => (list.value.find((c) => c.name === waitingFor.value)?.signedIn ? (waitingFor.value = null) : undefined))
}
onMounted(() => window.addEventListener('focus', back))
onBeforeUnmount(() => window.removeEventListener('focus', back))

async function act(name: string, what: () => Promise<void>): Promise<void> {
  busy[name] = true
  note.value = ''
  bad.value = ''
  try {
    await what()
  } catch (e) {
    bad.value = (e as ApiError).message
  } finally {
    busy[name] = false
  }
}

const at = (c: ConnectorView, rest = '') => `/api/connectors/${encodeURIComponent(c.name)}${rest}`
const check = (c: ConnectorView) => act(c.name, async () => putConnector((await api<{ connector: ConnectorView }>(at(c, '/check'), { method: 'POST' })).connector))
const toggle = (c: ConnectorView, enabled: boolean) => act(c.name, async () => putConnector((await api<{ connector: ConnectorView }>(at(c, '/enabled'), { method: 'POST', body: { enabled } })).connector))
const signIn = (c: ConnectorView) =>
  act(c.name, async () => {
    const { url } = await api<{ url: string }>(at(c, '/signin'), { method: 'POST' })
    waitingFor.value = c.name
    note.value = `Finish signing in to ${c.name} in your browser, then come back here.`
    window.open(url, '_blank', 'noopener')
  })
const remove = (c: ConnectorView) =>
  act(c.name, async () => {
    if (!confirm(`Remove the connector "${c.name}"? Its keys are deleted from HeyBotOS.`)) return
    await api(at(c), { method: 'DELETE' })
    list.value = list.value.filter((x) => x.name !== c.name)
    // What was allowed for it goes with it.
    const kept = allowedList.value.filter((t) => !t.startsWith(`${c.name}/`))
    if (kept.length !== allowedList.value.length) await change('tools', { gate: { alwaysAllowTools: kept } })
  })

function show(c: ConnectorView): void {
  open.value = open.value === c.name ? null : c.name
  find.value = ''
}

const words = (c: ConnectorView) => (!c.enabled ? 'Switched off' : c.needsSignIn ? 'Needs a sign-in' : c.error ? 'Not answering' : c.checkedAt ? `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}` : 'Not checked yet')
const tone = (c: ConnectorView): Tone => (!c.enabled ? 'muted' : c.needsSignIn ? 'wait' : c.error ? 'bad' : c.checkedAt ? 'ok' : 'muted')
const answering = computed(() => list.value.filter((c) => c.enabled && !c.error && c.checkedAt).length)

// ── what may change things without asking ──
const allowedList = computed(() => settings.value?.gate.alwaysAllowTools ?? [])
const allowed = (c: ConnectorView, tool: string) => allowedList.value.includes(`${c.name}/${tool}`) || allowedList.value.includes(`${c.name}/*`)
const allowedCount = (c: ConnectorView) => c.asks.filter((t) => allowed(c, t)).length

function allow(c: ConnectorView, tool: string, on: boolean): void {
  // "All of this connector" is stored as one line; taking a single tool out of it spells the rest out.
  const mine = new Set(c.asks.filter((t) => allowed(c, t)))
  if (on) mine.add(tool)
  else mine.delete(tool)
  const others = allowedList.value.filter((t) => !t.startsWith(`${c.name}/`))
  void change('tools', { gate: { alwaysAllowTools: [...others, ...[...mine].map((t) => `${c.name}/${t}`)] } })
}

const match = (t: string) => !find.value.trim() || t.toLowerCase().includes(find.value.trim().toLowerCase())
const reads = (c: ConnectorView) => c.tools.filter((t) => !c.asks.includes(t) && match(t))
const asks = (c: ConnectorView) => c.asks.filter(match)

// ── adding one ──
const dialog = ref<HTMLDialogElement | null>(null)
const form = reactive({ name: '', target: '', keys: '' })
const adding = ref(false)
const formBad = ref('')
const isUrl = computed(() => /^https?:\/\//i.test(form.target.trim()))

function startAdding(): void {
  formBad.value = ''
  dialog.value?.showModal()
}

/** "Name: value" lines for a web address, "NAME=value" lines for a program. */
function pairs(text: string, sep: ':' | '='): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

async function add(): Promise<void> {
  adding.value = true
  note.value = ''
  bad.value = ''
  formBad.value = ''
  try {
    const target = form.target.trim()
    const parts = (target.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'))
    const body = isUrl.value ? { name: form.name, url: target, headers: pairs(form.keys, ':') } : { name: form.name, command: parts[0] ?? '', args: parts.slice(1), env: pairs(form.keys, '=') }
    const { connector } = await api<{ connector: ConnectorView }>('/api/connectors', { method: 'POST', body })
    putConnector(connector)
    note.value = connector.error ? `${connector.name} is saved, but it did not answer: ${connector.error}` : `${connector.name} is connected, with ${connector.tools.length} tools. Every engine can use it now.`
    form.name = ''
    form.target = ''
    form.keys = ''
    dialog.value?.close()
  } catch (e) {
    formBad.value = (e as ApiError).message
  } finally {
    adding.value = false
  }
}

async function bringIn(): Promise<void> {
  adding.value = true
  note.value = ''
  bad.value = ''
  formBad.value = ''
  try {
    const res = await api<{ added: string[]; list: ConnectorView[] }>('/api/connectors/import', { method: 'POST' })
    list.value = res.list
    note.value = res.added.length ? `Brought in ${res.added.join(', ')}.` : 'Nothing new in Claude Code.'
    dialog.value?.close()
  } catch (e) {
    formBad.value = (e as ApiError).message
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <section aria-labelledby="cn-title">
    <div class="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div class="min-w-0 flex-1">
        <h2 id="cn-title" class="pane-title">Connectors</h2>
        <p class="pane-lede">Connect a system here once. Workers on Claude, Codex and Grok all reach it through HeyBotOS, which keeps the keys to itself. Looking things up goes straight through; anything that changes something waits for your yes.</p>
      </div>
      <button type="button" class="btn btn-primary" @click="startAdding">Add connector</button>
    </div>
    <p class="mt-3 min-h-5 px-1"><span class="text-ok" role="status">{{ note }}</span><span class="text-bad" role="alert">{{ bad }}</span></p>

    <div v-if="list.length" class="mt-2">
      <p class="telemetry mb-2 px-1">{{ answering }} of {{ list.length }} answering</p>
      <ul class="set-panel">
        <li v-for="c in list" :key="c.name" class="border-line-soft border-t first:border-t-0">
          <div class="flex min-h-14 items-center gap-3 px-4 py-2">
            <span class="tile" :class="{ off: !c.enabled }" :style="{ '--h': hueOf(c.name) }" aria-hidden="true">{{ c.name.charAt(0).toUpperCase() }}</span>
            <button type="button" class="opener" :aria-expanded="open === c.name" :aria-label="`${c.name}, ${c.where}`" @click="show(c)">
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold" :class="c.enabled ? '' : 'text-ink-3'">{{ c.name }}</span>
                <span class="text-ink-3 block truncate text-xs">{{ c.where }}</span>
              </span>
              <svg viewBox="0 0 12 12" class="arrow" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
            </button>
            <span class="flex shrink-0 items-center gap-1.5 text-xs font-medium" :class="tone(c) === 'wait' ? 'text-wait' : tone(c) === 'bad' ? 'text-bad' : 'text-ink-2'">
              <StatusDot :tone="tone(c)" :label="words(c)" class="!size-2" /><span class="max-sm:hidden">{{ words(c) }}</span>
            </span>
            <button v-if="c.needsSignIn" type="button" class="btn btn-primary" :disabled="busy[c.name]" @click="signIn(c)">Sign in</button>
            <button type="button" class="btn btn-ghost max-sm:hidden" :disabled="busy[c.name] || !c.enabled" @click="check(c)">{{ busy[c.name] ? 'Asking' : 'Check' }}</button>
            <UiSwitch :model-value="c.enabled" :label="`Use ${c.name}`" :disabled="busy[c.name]" @update:model-value="(on) => toggle(c, on)" />
          </div>

          <div v-if="open === c.name" class="detail">
            <p v-if="c.enabled && c.error" :class="c.needsSignIn ? 'text-ink-2' : 'text-bad'" role="alert">{{ c.error }}</p>
            <template v-if="c.tools.length">
              <input v-if="c.tools.length > 12" v-model="find" class="field mb-3 max-w-64" type="search" placeholder="Find a tool" :aria-label="`Find a tool in ${c.name}`" />
              <div v-if="reads(c).length" role="group" :aria-label="`${c.name}: looks things up`">
                <p class="sub">Looks things up <span class="text-ink-3 font-normal">goes straight through</span></p>
                <p class="mt-1.5 flex flex-wrap gap-1.5"><span v-for="t in reads(c)" :key="t" class="chip font-mono">{{ t }}</span></p>
              </div>
              <div v-if="asks(c).length" class="mt-4 first:mt-0" role="group" :aria-label="`${c.name}: changes things`">
                <p class="sub">
                  Changes things <span class="text-ink-3 font-normal">{{ allowedCount(c) ? `${allowedCount(c)} allowed without asking, the rest wait for your yes` : 'waits for your yes' }}</span>
                </p>
                <ul class="tools">
                  <li v-for="t in asks(c)" :key="t">
                    <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="t">{{ t }}</span>
                    <span class="text-xs" :class="allowed(c, t) ? 'text-ink' : 'text-ink-3'">{{ allowed(c, t) ? 'allowed' : 'asks' }}</span>
                    <UiSwitch :model-value="allowed(c, t)" :label="`Allow ${c.name} ${t} without asking`" @update:model-value="(on) => allow(c, t, on)" />
                  </li>
                </ul>
                <p v-if="saving.errors.tools" class="set-error" role="alert">{{ saving.errors.tools }}</p>
              </div>
              <p v-if="find.trim() && !reads(c).length && !asks(c).length" class="text-ink-3">No tool matches "{{ find.trim() }}".</p>
            </template>
            <p v-else-if="!c.error" class="text-ink-3">Press Check to ask it what it offers.</p>
            <p class="text-ink-3 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{{ c.transport === 'http' ? 'At a web address' : 'A program on this computer' }}, {{ c.source }}{{ c.signedIn ? ', signed in through the browser' : '' }}</span>
              <button type="button" class="hover:text-ink sm:hidden" :disabled="busy[c.name] || !c.enabled" @click="check(c)">Check again</button>
              <button type="button" class="text-bad ml-auto hover:underline" :disabled="busy[c.name]" @click="remove(c)">Remove</button>
            </p>
          </div>
        </li>
      </ul>
    </div>
    <div v-else class="set-panel mt-2 px-6 py-10 text-center">
      <p class="text-lg font-semibold">No connectors yet</p>
      <p class="text-ink-2 mx-auto mt-1 max-w-[44ch]">Add one, or bring in the ones Claude Code already has. Every engine can use them from then on.</p>
      <p class="mt-4 flex justify-center gap-2"><button type="button" class="btn" :disabled="adding" @click="bringIn">Bring in from Claude Code</button><button type="button" class="btn btn-primary" @click="startAdding">Add connector</button></p>
    </div>

    <dialog ref="dialog" class="bg-surface text-ink shadow-panel backdrop:bg-ink/40 m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl p-0" aria-labelledby="cn-add-title">
      <form class="p-6" aria-label="Add a connector" @submit.prevent="add">
        <h2 id="cn-add-title" class="text-2xl">Add a connector</h2>
        <p class="text-ink-2 mt-1.5 max-w-[52ch]">Give it a short name and say where it lives. HeyBotOS asks it what it offers and makes that available to every engine.</p>
        <label for="cn-name" class="mt-5 block text-sm font-medium">Name</label>
        <input id="cn-name" v-model="form.name" class="field mt-1.5" placeholder="shop" required autocomplete="off" spellcheck="false" aria-describedby="cn-name-hint" />
        <p id="cn-name-hint" class="text-ink-3 mt-1.5 text-xs">Spaces are fine. Workers see the name with dashes: "My CRM" is kept as "My-CRM".</p>
        <label for="cn-target" class="mt-4 block text-sm font-medium">Web address, or the command that starts it</label>
        <input id="cn-target" v-model="form.target" class="field mt-1.5 font-mono text-xs" placeholder="https://example.com/mcp   or   npx -y some-mcp-server" required autocomplete="off" spellcheck="false" />
        <label for="cn-keys" class="mt-4 block text-sm font-medium">{{ isUrl ? 'Sign-in headers, one per line (optional)' : 'Settings it needs in its environment, one per line (optional)' }}</label>
        <textarea id="cn-keys" v-model="form.keys" class="field mt-1.5 min-h-16 font-mono text-xs" spellcheck="false" autocomplete="off" :placeholder="isUrl ? 'Authorization: Bearer …' : 'NAME=value'"></textarea>
        <p class="text-ink-3 mt-1.5 text-xs">Kept in HeyBotOS's own database on this computer and never shown again, here or to a worker.</p>
        <p class="text-bad mt-3 min-h-5" role="alert">{{ formBad }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-ghost -ml-2" :disabled="adding" @click="bringIn">Bring in from Claude Code</button>
          <span class="flex-1"></span>
          <button type="button" class="btn" @click="dialog?.close()">Cancel</button>
          <button class="btn btn-primary" :disabled="adding">{{ adding ? 'Connecting' : 'Add connector' }}</button>
        </div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.tile {
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  flex-shrink: 0;
  border-radius: 9px;
  font-weight: 700;
  font-size: 0.875rem;
  color: hsl(var(--h) 70% 72%);
  background: hsl(var(--h) 55% 50% / 0.16);
  box-shadow: inset 0 0 0 1px hsl(var(--h) 60% 60% / 0.28);
}
:root[data-theme='light'] .tile {
  color: hsl(var(--h) 60% 36%);
  background: hsl(var(--h) 70% 50% / 0.11);
}
.tile.off {
  filter: saturate(0);
  opacity: 0.6;
}
.opener {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
  margin: -0.3rem -0.5rem;
  padding: 0.3rem 0.5rem;
  border-radius: 8px;
  text-align: left;
}
.opener:hover {
  background: var(--hover);
}
.arrow {
  width: 0.75rem;
  height: 0.75rem;
  flex-shrink: 0;
  color: var(--ink-3);
  transition: transform 0.15s;
}
.opener[aria-expanded='true'] .arrow {
  transform: rotate(90deg);
}
.detail {
  padding: 0.9rem 1rem 0.9rem;
  border-top: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--sunken) 60%, transparent);
}
.sub {
  font-size: 0.75rem;
  font-weight: 600;
}
.tools {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 1.5rem;
  margin-top: 0.3rem;
}
.tools li {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 2rem;
  border-bottom: 1px solid var(--line-soft);
}
@media (max-width: 40rem) {
  .tools {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
