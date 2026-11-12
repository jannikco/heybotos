<script setup lang="ts">
import { computed } from 'vue'
import Prose from './Prose.vue'
import type { Item } from '../transcript'

const props = defineProps<{ item: Item; live: boolean; streaming?: Record<string, { text: string; thinking: string }> }>()

const d = computed(() => props.item.ev.data as Record<string, any>)
const kind = computed(() => props.item.ev.kind)
const failed = computed(() => props.item.result?.data.isError === true)
const pending = computed(() => kind.value === 'tool_start' && !props.item.result && props.live)
const input = computed(() => {
  const i = d.value.input ?? {}
  if (typeof i.command === 'string') return i.command
  return JSON.stringify(i, null, 2)
})
const inner = computed(() => props.streaming?.[String(d.value.id)])

function limitText(): string {
  const pct = typeof d.value.utilization === 'number' ? `${Math.round(d.value.utilization * 100)}%` : ''
  const window = String(d.value.window ?? '').replace('seven_day', 'weekly').replace('five_hour', 'five-hour').replace(/_/g, ' ')
  const resets = d.value.resetsAt ? new Date(Number(d.value.resetsAt) * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  if (d.value.status === 'rejected') return `The ${window} usage limit is used up${resets ? `. It resets ${resets}` : ''}.`
  return `The ${window} usage limit is at ${pct}${resets ? `. It resets ${resets}` : ''}.`
}
</script>

<template>
  <!-- What the agent said -->
  <Prose v-if="kind === 'text'" class="text-lg leading-relaxed" :text="String(d.text)" />

  <details v-else-if="kind === 'thinking'" class="text-ink-3 text-sm">
    <summary class="hover:text-ink-2 cursor-pointer select-none">Thought it through</summary>
    <p class="border-line mt-1.5 max-w-[68ch] whitespace-pre-wrap border-l-2 pl-3">{{ d.text }}</p>
  </details>

  <!-- A hand-off to a sub-agent, with everything it did nested inside -->
  <section v-else-if="kind === 'tool_start' && d.subagent" class="border-wait/50 border-l-2 pl-4">
    <p class="flex items-baseline gap-2 font-medium">
      <span class="text-wait text-sm">Sub-agent</span>
      <span class="min-w-0 truncate">{{ String(d.label).replace(/^Handing off: /, '') }}</span>
      <span v-if="pending" class="text-ink-3 ml-auto shrink-0 text-sm">working</span>
    </p>
    <div class="mt-2.5 flex flex-col gap-3">
      <TranscriptItem v-for="c in item.children" :key="c.ev.id" :item="c" :live="live" :streaming="streaming" />
      <Prose v-if="inner?.text" class="text-ink-2 caret" :text="inner.text" live />
    </div>
    <details v-if="item.result" class="text-ink-2 mt-2.5 text-sm">
      <summary class="cursor-pointer select-none" :class="failed ? 'text-bad' : ''">{{ failed ? 'It failed' : 'What it reported back' }}</summary>
      <pre class="bg-sunken mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2 font-mono text-xs leading-relaxed">{{ item.result.data.text }}</pre>
    </details>
  </section>

  <!-- A tool call and its result -->
  <details v-else-if="kind === 'tool_start'" class="t-tool">
    <summary class="hover:bg-sunken -mx-2 flex cursor-pointer select-none list-none items-baseline gap-2.5 rounded-md px-2 py-1 [&::-webkit-details-marker]:hidden">
      <span class="mt-px size-1.5 shrink-0 self-center rounded-full" :class="failed ? 'bg-bad' : pending ? 'bg-signal dot-working' : 'bg-ink-3'"></span>
      <span class="min-w-0 truncate" :class="failed ? 'text-bad' : 'text-ink-2'">{{ d.label }}</span>
      <span class="telemetry ml-auto shrink-0" :class="failed ? '!text-bad' : pending ? '!text-signal' : ''">{{ failed ? 'failed' : pending ? 'running' : String(d.name).startsWith('mcp__') ? 'connector' : d.name }}</span>
    </summary>
    <div class="mt-1.5 space-y-1.5 pl-4">
      <pre class="bg-sunken max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-xs leading-relaxed">{{ input }}</pre>
      <pre v-if="item.result && item.result.data.text" class="border-line max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed" :class="failed ? 'text-bad' : 'text-ink-2'">{{ item.result.data.text }}</pre>
      <p v-else-if="item.result" class="text-ink-3 text-sm">No output.</p>
    </div>
  </details>

  <details v-else-if="kind === 'subagent'" class="text-ink-3 text-sm">
    <summary class="cursor-pointer select-none">The brief it was given</summary>
    <p class="mt-1.5 max-w-[68ch] whitespace-pre-wrap">{{ d.text }}</p>
  </details>

  <p v-else-if="kind === 'error'" class="bg-bad-soft text-bad whitespace-pre-wrap rounded-lg px-3.5 py-2.5" role="alert">{{ d.message }}</p>

  <p v-else-if="kind === 'limit'" class="bg-wait-soft text-wait rounded-lg px-3.5 py-2.5">{{ limitText() }}</p>

  <p v-else-if="kind === 'phase' && d.phase === 'init'" class="text-ink-3 text-sm">
    Started on {{ d.model }}<template v-if="(d.connectors ?? []).length">, with {{ d.connectors.map((c: any) => c.name).join(', ') }}</template
    ><template v-else>, with no connectors</template>.
  </p>
  <p v-else-if="kind === 'phase' && d.phase === 'retry'" class="text-ink-3 text-sm">The model did not answer; trying again (attempt {{ d.attempt }}).</p>
  <p v-else-if="kind === 'phase' && d.phase === 'compacted'" class="text-ink-3 text-sm">It summarised its earlier work to free up room.</p>

  <!-- The end of the turn -->
  <section v-else-if="kind === 'result' && d.report" class="report rounded-2xl px-5 py-4">
    <h3 class="text-lg">Report</h3>
    <Prose class="mt-1.5" :text="String(d.report.summary)" />
    <dl class="mt-3 space-y-2.5 text-sm">
      <div v-if="d.report.question">
        <dt class="text-wait font-medium">It needs to know</dt>
        <dd>{{ d.report.question }}</dd>
      </div>
      <div v-if="d.report.verification">
        <dt class="text-ink-3">How it checked</dt>
        <dd>{{ d.report.verification }}</dd>
      </div>
      <div v-if="d.report.files_changed?.length">
        <dt class="text-ink-3">Files it changed</dt>
        <dd class="font-mono text-xs leading-relaxed">
          <span v-for="f in d.report.files_changed" :key="f" class="block truncate">{{ f }}</span>
        </dd>
      </div>
      <div v-if="d.report.follow_ups?.length">
        <dt class="text-ink-3">Worth doing next</dt>
        <dd>
          <ul class="list-disc pl-4">
            <li v-for="f in d.report.follow_ups" :key="f">{{ f }}</li>
          </ul>
        </dd>
      </div>
    </dl>
  </section>
  <p v-else-if="kind === 'result' && d.deferred" class="bg-wait-soft text-wait rounded-lg px-3.5 py-2.5">It stopped to ask before running: {{ d.deferred.name }}.</p>
</template>

<style>
.report {
  background:
    radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--ok) 12%, transparent), transparent 60%),
    var(--glass);
  border: 1px solid color-mix(in srgb, var(--ok) 30%, var(--line));
}
.t-tool {
  position: relative;
}
.t-tool + .t-tool::before {
  content: '';
  position: absolute;
  left: 0.16rem;
  top: -0.55rem;
  height: 0.95rem;
  width: 1px;
  background: var(--line);
}
/* A run of tool calls reads as one list: pull neighbours together inside the transcript's wider rhythm. */
.t-tool + .t-tool {
  margin-top: -0.625rem;
}
</style>
