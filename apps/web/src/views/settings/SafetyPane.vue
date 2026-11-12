<script setup lang="ts">
// What waits for your yes: which servers the team may reach by itself, whether it may use your SSH
// keys, and which commands and connector changes are let through.
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import SettingGroup from '../../components/ui/SettingGroup.vue'
import SettingRow from '../../components/ui/SettingRow.vue'
import UiList from '../../components/ui/UiList.vue'
import UiStepper from '../../components/ui/UiStepper.vue'
import UiSwitch from '../../components/ui/UiSwitch.vue'
import { change, saving, settings } from '../../settings'

const g = computed(() => settings.value!.gate)

// Code hosting is reached by plain git commands all day; these come allowed.
const BUILT_IN = ['localhost', '127.0.0.1', '::1', 'github.com', 'gitlab.com', 'bitbucket.org']

// Every server worth a line: the ones in your SSH config, and any other that is allowed. One that
// is switched off here stays on the page until you leave, so a slip is easy to take back.
const seen = ref<string[]>([])
const servers = computed(() => {
  const all = new Set([...g.value.knownServers, ...g.value.allowedHosts, ...seen.value])
  return [...all].filter((h) => !BUILT_IN.includes(h)).sort((a, b) => a.localeCompare(b))
})
const builtIn = computed(() => BUILT_IN.filter((h) => g.value.allowedHosts.includes(h)))
const isAllowed = (h: string) => g.value.allowedHosts.includes(h)
const from = (h: string) => (g.value.knownServers.includes(h) ? 'In your SSH config' : 'Added by you')

function setHost(h: string, on: boolean): Promise<boolean> {
  if (!seen.value.includes(h)) seen.value = [...seen.value, h]
  const hosts = g.value.allowedHosts.filter((x) => x !== h)
  return change(`host.${h}`, { gate: { allowedHosts: on ? [...hosts, h] : hosts } })
}

const newHost = ref('')
async function addHost(): Promise<void> {
  const h = newHost.value.trim().toLowerCase()
  if (!h) return
  delete saving.errors.host
  if (await change('host', { gate: { allowedHosts: [...g.value.allowedHosts.filter((x) => x !== h), h] } })) {
    seen.value = [...seen.value, h]
    newHost.value = ''
  }
}

const sshAgent = computed({ get: () => g.value.sshAgent, set: (on) => void change('sshAgent', { gate: { sshAgent: on } }) })
const minutes = computed({ get: () => g.value.hostGrantMinutes, set: (n) => void change('minutes', { gate: { hostGrantMinutes: n } }) })

const dropTool = (t: string) => change('tools', { gate: { alwaysAllowTools: g.value.alwaysAllowTools.filter((x) => x !== t) } })
const toolWords = (t: string) => {
  const [connector = '', tool = ''] = t.split('/')
  return tool === '*' ? `Everything in ${connector}` : `${connector}: ${tool}`
}

const addPattern = (p: string) => change('patterns', { gate: { askCommandPatterns: [...g.value.askCommandPatterns, p] } })
const removePattern = (p: string) => change('patterns', { gate: { askCommandPatterns: g.value.askCommandPatterns.filter((x) => x !== p) } })
</script>

<template>
  <div>
    <h2 class="pane-title">Safety</h2>
    <p class="pane-lede">The team works without asking. Three things wait for your yes: reaching a server that is not allowed here, deploying or publishing, and changing something through a connector.</p>

    <SettingGroup title="Servers" hint="A worker that wants a server that is not allowed stops and asks. Your yes can be for once or from then on.">
      <form class="add" aria-label="Allow a server" @submit.prevent="addHost">
        <input v-model="newHost" class="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" placeholder="server name, like web1 or *.example.com" aria-label="Server name" autocomplete="off" spellcheck="false" />
        <button class="btn" :disabled="!newHost.trim()">Allow server</button>
      </form>
      <p v-if="saving.errors.host" class="set-error px-4 py-2" role="alert">{{ saving.errors.host }}</p>
      <ul class="servers" aria-label="Servers">
        <li v-for="h in servers" :key="h" :title="from(h)">
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :class="isAllowed(h) ? 'text-ink font-semibold' : 'text-ink-2'">{{ h }}</span>
          <span class="text-xs" :class="isAllowed(h) ? 'text-ink' : 'text-ink-3'">{{ isAllowed(h) ? 'allowed' : 'asks first' }}</span>
          <UiSwitch :model-value="isAllowed(h)" :label="`Reach ${h} without asking`" @update:model-value="(on) => setHost(h, on)" />
          <p v-if="saving.errors[`host.${h}`]" class="set-error w-full" role="alert">{{ saving.errors[`host.${h}`] }}</p>
        </li>
      </ul>
      <p v-if="!servers.length" class="text-ink-3 px-4 py-3">No servers yet. Every server a worker wants will ask first.</p>
      <p v-if="builtIn.length" class="text-ink-3 border-line-soft border-t px-4 py-2.5 text-xs">Always reachable, because plain git needs them: {{ builtIn.join(', ') }}.</p>
    </SettingGroup>

    <SettingGroup label="Reaching servers">
      <SettingRow title="Use my SSH keys" hint="Workers go through your SSH agent, so keys with a passphrase work for them too. Which servers they may reach is still decided above." :error="saving.errors.sshAgent" class="keep">
        <UiSwitch v-model="sshAgent" label="Use my SSH keys" />
      </SettingRow>
      <SettingRow title="A yes lasts" hint="After you allow a server once, workers may connect again for this long without asking, so a deploy that makes several connections asks once." :error="saving.errors.minutes">
        <UiStepper v-model="minutes" label="A yes lasts, in minutes" :min="1" :max="240" :step="5" unit="min" />
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="Connector changes allowed without asking">
      <template #aside><RouterLink to="/settings/connectors" class="btn btn-ghost">Open Connectors</RouterLink></template>
      <ul v-if="g.alwaysAllowTools.length" aria-label="Connector changes allowed without asking">
        <li v-for="t in g.alwaysAllowTools" :key="t" class="set-row keep">
          <p class="truncate font-mono text-xs font-semibold">{{ toolWords(t) }}</p>
          <button type="button" class="btn btn-ghost" :aria-label="`Make ${toolWords(t)} ask again`" @click="dropTool(t)">Ask again</button>
        </li>
      </ul>
      <p v-else class="text-ink-2 px-4 py-3.5">None. Every change through a connector waits for your yes. To let a single tool through, open the connector and switch that tool to allowed.</p>
      <p v-if="saving.errors.tools" class="set-error px-4 pb-3" role="alert">{{ saving.errors.tools }}</p>
    </SettingGroup>

    <SettingGroup title="Commands that always ask" hint="Deploying and publishing always ask. Add a pattern (a regular expression) for any other command that should wait for your yes.">
      <UiList label="Commands that always ask" :items="g.askCommandPatterns" placeholder="^terraform apply" add-label="Add pattern" :add="addPattern" :remove="removePattern" mono />
      <p v-if="saving.errors.patterns" class="set-error px-4 pb-3" role="alert">{{ saving.errors.patterns }}</p>
    </SettingGroup>
  </div>
</template>

<style scoped>
.servers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 2rem;
  padding: 0.25rem 1rem;
}
.servers li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  min-height: 2.25rem;
  border-bottom: 1px solid var(--line-soft);
}
/* The last row of each column has no line under it. */
.servers li:last-child,
.servers li:nth-last-child(2):nth-child(odd) {
  border-bottom: 0;
}
@media (max-width: 40rem) {
  .servers {
    grid-template-columns: minmax(0, 1fr);
  }
  .servers li:nth-last-child(2):nth-child(odd) {
    border-bottom: 1px solid var(--line-soft);
  }
}
.add {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0 0.6rem 0 1rem;
  border-bottom: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--sunken) 55%, transparent);
}
.add input::placeholder {
  color: var(--ink-3);
}
</style>
