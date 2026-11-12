<script setup lang="ts">
// The three engines: whether each is signed in, how full its plan is, which model it runs, and how
// work is spread between them. The mark on the usage bars is the setting itself: above it, new
// workers wait, so there is room left on the plan for you.
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import type { Engine, EngineUsage, TaskKind } from '@heybotos/protocol'
import StatusDot from '../../components/StatusDot.vue'
import EngineChoice from '../../components/ui/EngineChoice.vue'
import SettingGroup from '../../components/ui/SettingGroup.vue'
import SettingRow from '../../components/ui/SettingRow.vue'
import UiSegmented from '../../components/ui/UiSegmented.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { ENGINE_NAME, tokens, type Tone } from '../../format'
import { change, loadUsage, saving, settings, usage } from '../../settings'
import { refreshHealth, state } from '../../store'

const ENGINES = ['claude', 'codex', 'grok'] as const
const KINDS: Array<[TaskKind, string]> = [['build', 'Building and fixing'], ['review', 'Reviewing'], ['research', 'Research'], ['write', 'Writing'], ['ops', 'Operations'], ['other', 'Everything else']]
// Some readings come without a number, only with how it stands.
const STATUS_WORDS: Record<string, string> = { allowed: 'under the limit', allowed_warning: 'nearly full', rejected: 'used up' }
const WINDOW_NAME: Record<string, string> = { five_hour: 'Five-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly, largest model', limit: 'Usage limit' }

const r = computed(() => settings.value!.routing)
const mode = computed({ get: () => r.value.mode, set: (m) => void change('mode', { routing: { mode: m } }) })
const fallback = computed({ get: () => r.value.fallback, set: (on) => void change('fallback', { routing: { fallback: on } }) })
const setKind = (k: TaskKind, e: Engine) => void change('byKind', { routing: { byKind: { ...r.value.byKind, [k]: e } } })
const setPool = (e: Engine, on: boolean) => void change(`pool.${e}`, { routing: { pool: ENGINES.filter((x) => (x === e ? on : r.value.pool.includes(x))) } })
const setModel = (e: Engine, what: 'model' | 'effort', v: string) => void change(`${what}.${e}`, { engines: { ...settings.value!.engines, [e]: { ...settings.value!.engines[e], [what]: v } } })

let timer = 0
onMounted(() => {
  void loadUsage().catch(() => {})
  void refreshHealth().catch(() => {})
  timer = window.setInterval(() => void loadUsage().catch(() => {}), 15_000)
})
onBeforeUnmount(() => window.clearInterval(timer))

const use = (e: Engine): EngineUsage | undefined => usage.value?.find((u) => u.engine === e)
const health = (e: Engine) => state.health?.find((h) => h.engine === e)
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

// ── the hold-back mark ──
// While it is being moved the mark follows the hand; the setting is saved when it is let go.
const moving = reactive<Partial<Record<Engine, number>>>({})
const mark = (e: Engine) => moving[e] ?? r.value.headroom[e]
const pct = (e: Engine) => Math.round(mark(e) * 100)
const clamp = (n: number) => Math.min(1, Math.max(0.5, Math.round(n * 100) / 100))

async function keep(e: Engine): Promise<void> {
  const v = moving[e]
  if (v === undefined) return
  if (v !== r.value.headroom[e]) await change(`headroom.${e}`, { routing: { headroom: { ...r.value.headroom, [e]: v } } })
  if (moving[e] === v) delete moving[e]
}
function drag(e: Engine, ev: PointerEvent): void {
  const handle = ev.currentTarget as HTMLElement
  const track = handle.parentElement!
  handle.setPointerCapture(ev.pointerId)
  const at = (x: number) => {
    const box = track.getBoundingClientRect()
    moving[e] = clamp((x - box.left) / box.width)
  }
  const move = (m: PointerEvent) => at(m.clientX)
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    void keep(e)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
  ev.preventDefault()
  handle.focus()
}
const keyTimers: Partial<Record<Engine, number>> = {}
function nudge(e: Engine, ev: KeyboardEvent): void {
  const by: Record<string, number> = { ArrowLeft: -0.01, ArrowDown: -0.01, ArrowRight: 0.01, ArrowUp: 0.01, PageDown: -0.05, PageUp: 0.05 }
  let next: number
  if (ev.key === 'Home') next = 0.5
  else if (ev.key === 'End') next = 1
  else if (ev.key in by) next = clamp(mark(e) + by[ev.key]!)
  else return
  ev.preventDefault()
  moving[e] = next
  window.clearTimeout(keyTimers[e])
  keyTimers[e] = window.setTimeout(() => void keep(e), 350)
}
onBeforeUnmount(() => {
  for (const e of ENGINES) {
    window.clearTimeout(keyTimers[e])
    void keep(e)
  }
})

/** Does this engine tell how full the plan is? Only then is there a bar to put the mark on. */
const reports = (e: Engine) => e === 'claude' || (use(e)?.windows.length ?? 0) > 0
const over = (e: Engine, utilization: number | null) => (utilization ?? 0) >= mark(e)

function standing(e: Engine): { words: string; tone: Tone } {
  const h = health(e)
  const u = use(e)
  if (!h) return { words: 'Checking', tone: 'muted' }
  if (!h.found) return { words: 'Not installed', tone: 'bad' }
  if (!h.loggedIn) return { words: 'Needs a sign-in', tone: 'bad' }
  if (u?.coolingUntil) return { words: `On hold until ${time(u.coolingUntil)}`, tone: 'wait' }
  if (u?.windows.some((w) => over(e, w.utilization))) return { words: 'Holding new workers back', tone: 'wait' }
  return { words: 'Ready', tone: 'ok' }
}
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', wait: 'text-wait', bad: 'text-bad', signal: 'text-signal', muted: 'text-ink-3' }

function today(u: EngineUsage | undefined): string {
  if (!u) return ''
  const parts = [`${u.workingNow} working now`, `${u.runsToday} turn${u.runsToday === 1 ? '' : 's'} today`]
  if (u.tokensOutToday) parts.push(`${tokens(u.tokensOutToday)} tokens written`)
  return parts.join(', ')
}
</script>

<template>
  <div>
    <h2 class="pane-title">Engines</h2>
    <p class="pane-lede">Three subscriptions do the work. HeyBotOS only runs their official tools with your own logins, so the only meter is each plan's limit.</p>

    <SettingGroup label="How work is spread">
      <SettingRow title="How work is spread" :error="saving.errors.mode">
        <template #hint>
          <template v-if="mode === 'balanced'">Each new task goes to whichever engine has room and the fewest workers out. A review goes to a different engine than the work it checks.</template>
          <template v-else>Each kind of work has its own engine. You and the manager can still name an engine for a single task.</template>
        </template>
        <UiSegmented v-model="mode" label="How work is spread" :options="[{ value: 'balanced', label: 'Automatic' }, { value: 'rules', label: 'By kind of work' }]" />
      </SettingRow>
      <div v-if="mode === 'rules'" class="border-line-soft border-t px-4 py-3">
        <table class="grid-table" aria-label="Which engine does which kind of work">
          <thead>
            <tr>
              <th></th>
              <th v-for="e in ENGINES" :key="e" scope="col">{{ ENGINE_NAME[e] }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[k, name] in KINDS" :key="k">
              <th scope="row">{{ name }}</th>
              <td v-for="e in ENGINES" :key="e">
                <label class="cell"><input type="radio" class="radio" :name="`kind-${k}`" :checked="r.byKind[k] === e" :aria-label="`${name}: ${ENGINE_NAME[e]}`" @change="setKind(k, e)" /></label>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="saving.errors.byKind" class="set-error" role="alert">{{ saving.errors.byKind }}</p>
      </div>
      <SettingRow v-if="mode === 'rules'" title="Move work when an engine is full" hint="When an engine is at its limit or signed out, its waiting work goes to another one instead of waiting." :error="saving.errors.fallback" class="keep">
        <UiSwitch v-model="fallback" label="Move work when an engine is full" />
      </SettingRow>
    </SettingGroup>

    <section v-for="e in ENGINES" :key="e" class="set-panel mt-4" :aria-label="ENGINE_NAME[e]">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4">
        <span class="sigil" aria-hidden="true"><i :class="e"></i></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-xl leading-tight">{{ ENGINE_NAME[e] }}</h3>
          <p class="mt-0.5 flex items-center gap-1.5 text-xs font-medium" :class="TONE_TEXT[standing(e).tone]">
            <StatusDot :tone="standing(e).tone" :label="standing(e).words" class="!size-2" />{{ standing(e).words }}
          </p>
        </div>
        <label v-if="mode === 'balanced'" class="text-ink-2 flex items-center gap-2 text-xs">
          Shares the work
          <UiSwitch :model-value="r.pool.includes(e)" :label="`${ENGINE_NAME[e]} shares the work`" @update:model-value="(on) => setPool(e, on)" />
        </label>
      </header>
      <p class="text-ink-2 px-4 pt-2 text-xs">{{ health(e)?.detail ?? 'Asking the tool about itself…' }}</p>
      <p v-if="saving.errors[`pool.${e}`]" class="set-error px-4" role="alert">{{ saving.errors[`pool.${e}`] }}</p>

      <div v-if="reports(e)" class="px-4 pb-1 pt-4">
        <div class="chart">
          <template v-for="(w, i) in use(e)?.windows.length ? use(e)!.windows : [null]" :key="w?.window ?? 'none'">
            <p class="name" :style="{ gridRow: i + 1 }">
              {{ w ? (WINDOW_NAME[w.window] ?? w.window.replace(/_/g, ' ')) : 'Usage' }}
              <span v-if="w?.resetsAt" class="text-ink-3 block text-[0.6875rem] font-normal">resets {{ when(w.resetsAt) }}</span>
            </p>
            <div class="bar" :style="{ gridRow: i + 1 }" role="meter" :aria-label="w ? `${WINDOW_NAME[w.window] ?? w.window} used` : 'Usage'" :aria-valuenow="Math.round((w?.utilization ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100">
              <i :class="over(e, w?.utilization ?? null) ? 'bg-wait' : 'bg-signal'" :style="{ width: `${Math.min(100, Math.round((w?.utilization ?? 0) * 100))}%` }"></i>
            </div>
            <p class="num tabular" :style="{ gridRow: i + 1 }" :class="over(e, w?.utilization ?? null) ? 'text-wait' : ''">
              <template v-if="w && w.utilization !== null">{{ Math.round(w.utilization * 100) }}%</template>
              <span v-else class="text-ink-3 font-normal">{{ w ? (STATUS_WORDS[w.status] ?? w.status.replace(/_/g, ' ')) : '–' }}</span>
            </p>
          </template>
          <!-- The mark: one line across every bar, moved by hand or with the arrow keys. -->
          <div class="rail" :style="{ gridRow: `1 / span ${Math.max(1, use(e)?.windows.length ?? 1)}` }">
            <div
              class="mark"
              :class="{ live: moving[e] !== undefined }"
              :style="{ left: `${pct(e)}%` }"
              role="slider"
              tabindex="0"
              aria-orientation="horizontal"
              :aria-label="`${ENGINE_NAME[e]}: hold new workers back above`"
              aria-valuemin="50"
              aria-valuemax="100"
              :aria-valuenow="pct(e)"
              :aria-valuetext="`${pct(e)} percent`"
              @pointerdown="drag(e, $event)"
              @keydown="nudge(e, $event)"
            >
              <span class="flag tabular">{{ pct(e) }}%</span>
            </div>
          </div>
        </div>
        <p class="text-ink-2 mt-3 text-xs">
          <template v-if="!use(e)?.windows.length">No reading yet; the first worker turn brings one. </template>
          <template v-if="pct(e) >= 100">New workers are never held back on {{ ENGINE_NAME[e] }}. Drag the mark left to keep room on the plan for yourself.</template>
          <template v-else>New workers wait once a limit passes {{ pct(e) }}%, so the rest of the plan is yours. Drag the mark to change it; the manager is never held back.</template>
        </p>
        <p v-if="saving.errors[`headroom.${e}`]" class="set-error" role="alert">{{ saving.errors[`headroom.${e}`] }}</p>
      </div>
      <p v-else class="text-ink-3 px-4 pt-3 text-xs">{{ ENGINE_NAME[e] }} does not tell how much of the plan is used. HeyBotOS learns about its limit when a turn is refused, and then moves waiting work to another engine.</p>

      <footer class="border-line-soft mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3">
        <label class="pick">Model<EngineChoice :model-value="settings!.engines[e].model" :engine="e" what="model" :label="`${ENGINE_NAME[e]} model`" class="w-44" @update:model-value="(v) => setModel(e, 'model', v)" /></label>
        <label class="pick">Effort<EngineChoice :model-value="settings!.engines[e].effort" :engine="e" what="effort" :label="`${ENGINE_NAME[e]} effort`" class="w-32" @update:model-value="(v) => setModel(e, 'effort', v)" /></label>
        <p class="telemetry ml-auto">{{ today(use(e)) }}</p>
        <p v-if="saving.errors[`model.${e}`] || saving.errors[`effort.${e}`]" class="set-error w-full" role="alert">{{ saving.errors[`model.${e}`] || saving.errors[`effort.${e}`] }}</p>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* Shape, not brand colour, tells the engines apart (as everywhere else in the app). */
.sigil {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 10px;
  background: var(--sunken);
  border: 1px solid var(--line);
}
.sigil i {
  width: 0.8rem;
  height: 0.8rem;
  background: var(--ink);
}
.sigil .claude {
  border-radius: 999px;
}
.sigil .codex {
  border-radius: 3px;
}
.sigil .grok {
  border-radius: 2px;
  transform: rotate(45deg) scale(0.86);
}

.chart {
  display: grid;
  grid-template-columns: minmax(6.5rem, auto) minmax(0, 1fr) minmax(2.75rem, auto);
  column-gap: 0.9rem;
  row-gap: 0.85rem;
  align-items: center;
  /* room above the bars for the mark's flag */
  padding-top: 1.5rem;
}
.name {
  grid-column: 1;
  font-weight: 500;
  line-height: 1.25;
}
.bar {
  grid-column: 2;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--active);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}
.num {
  grid-column: 3;
  white-space: nowrap;
  text-align: right;
  font-weight: 600;
}
.rail {
  grid-column: 2;
  position: relative;
  align-self: stretch;
  pointer-events: none;
}
.mark {
  position: absolute;
  top: -0.45rem;
  bottom: -0.45rem;
  width: 1.25rem;
  margin-left: -0.625rem;
  cursor: ew-resize;
  pointer-events: auto;
  touch-action: none;
  border-radius: 4px;
}
.mark::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  border-radius: 2px;
  background: var(--ink);
}
.flag {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 1px;
  padding: 0.05rem 0.38rem;
  border-radius: 5px;
  background: var(--ink);
  color: var(--paper);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.35;
  white-space: nowrap;
  transition: transform 0.12s;
}
.mark:hover .flag,
.mark.live .flag,
.mark:focus-visible .flag {
  transform: translateX(-50%) scale(1.1);
}
.mark:focus-visible {
  outline: none;
}
.mark:focus-visible .flag {
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--signal);
}

.pick {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ink-2);
}

.grid-table {
  width: 100%;
  border-collapse: collapse;
}
.grid-table th {
  font-weight: 500;
  text-align: left;
}
.grid-table thead th {
  padding-bottom: 0.35rem;
  width: 5.25rem;
  text-align: center;
  font-size: 0.75rem;
  color: var(--ink-2);
}
.grid-table thead th:first-child {
  width: auto;
}
.grid-table tbody tr {
  border-top: 1px solid var(--line-soft);
}
.grid-table tbody th {
  padding: 0.4rem 0;
}
.grid-table td {
  text-align: center;
}
.cell {
  display: grid;
  place-items: center;
  height: 2rem;
  border-radius: 6px;
}
.cell:hover {
  background: var(--hover);
}
@media (max-width: 30rem) {
  .grid-table thead th {
    width: 3.6rem;
  }
  .chart {
    grid-template-columns: minmax(5rem, auto) minmax(0, 1fr) minmax(2.4rem, auto);
    column-gap: 0.6rem;
  }
}
</style>
