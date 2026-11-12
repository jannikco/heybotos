<script setup lang="ts">
// The one who leads the team: what it is called and how it thinks.
import { computed } from 'vue'
import AgentFace from '../../components/AgentFace.vue'
import EngineTag from '../../components/EngineTag.vue'
import EngineChoice from '../../components/ui/EngineChoice.vue'
import SettingGroup from '../../components/ui/SettingGroup.vue'
import SettingRow from '../../components/ui/SettingRow.vue'
import UiStepper from '../../components/ui/UiStepper.vue'
import { change, saving, settings, useDraft } from '../../settings'

const m = computed(() => settings.value!.manager)
const name = useDraft(
  () => m.value.name,
  (v) => change('manager.name', { manager: { name: v } }),
)
const model = computed({ get: () => m.value.model, set: (v) => void change('manager.model', { manager: { model: v } }) })
const effort = computed({ get: () => m.value.effort, set: (v) => void change('manager.effort', { manager: { effort: v } }) })
const batch = computed({ get: () => m.value.batchSeconds, set: (n) => void change('manager.batch', { manager: { batchSeconds: n } }) })
</script>

<template>
  <div>
    <div class="flex items-center gap-4">
      <AgentFace seed="chief" :hue="250" chief :size="60" :badge="false" />
      <div class="min-w-0">
        <h2 class="pane-title truncate">{{ m.name }}</h2>
        <p class="pane-lede !mt-1">Leads the team. You talk to it; it hands the work out and tells you how it went.</p>
      </div>
    </div>

    <SettingGroup label="Who it is">
      <SettingRow title="Name" for="mg-name" hint="What it is called in the sidebar and in conversations." :error="saving.errors['manager.name']">
        <input id="mg-name" v-model="name.text.value" class="field w-56" autocomplete="off" @input="name.touch" @change="name.flush" @keydown.enter="name.flush" />
      </SettingRow>
      <SettingRow title="Engine" hint="The manager always runs on Claude. Workers run on any of the three." class="keep">
        <EngineTag engine="claude" />
      </SettingRow>
      <SettingRow title="Model" for="mg-model" hint="A larger model plans better; a smaller one answers faster and uses less of the plan." :error="saving.errors['manager.model']">
        <EngineChoice id="mg-model" v-model="model" engine="claude" what="model" label="Model" class="w-56" />
      </SettingRow>
      <SettingRow title="Effort" for="mg-effort" hint="How long it thinks before it answers." :error="saving.errors['manager.effort']">
        <EngineChoice id="mg-effort" v-model="effort" engine="claude" what="effort" label="Effort" class="w-56" />
      </SettingRow>
    </SettingGroup>

    <SettingGroup label="Reports">
      <SettingRow title="Gather reports for" hint="When workers finish close together, the manager waits this long and reads their reports in one go. Your own messages are never held back." :error="saving.errors['manager.batch']">
        <UiStepper v-model="batch" label="Gather reports for, in seconds" :min="0" :max="600" :step="5" unit="s" />
      </SettingRow>
    </SettingGroup>
  </div>
</template>
