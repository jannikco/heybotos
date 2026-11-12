<script setup lang="ts">
// Engine, model and effort in one row. "Automatic" lets HeyBotOS spread work across the engines;
// picking an engine opens up the models that engine really offers on your plan.
import { computed, onMounted, watch } from 'vue'
import type { Engine, EngineModels } from '@heybotos/protocol'
import { api } from '../api'
import { ENGINE_NAME } from '../format'
import { state } from '../store'

const engine = defineModel<string>('engine', { required: true })
const model = defineModel<string>('model', { required: true })
const effort = defineModel<string>('effort', { required: true })
const props = withDefaults(defineProps<{ id: string; autoLabel?: string; autoValue?: string; fixed?: Engine }>(), { autoLabel: 'Automatic', autoValue: '' })

onMounted(async () => {
  if (!state.models) state.models = (await api<{ models: Record<Engine, EngineModels> }>('/api/models').catch(() => null))?.models ?? null
})
const chosen = computed<Engine | null>(() => props.fixed ?? (engine.value === 'claude' || engine.value === 'codex' || engine.value === 'grok' ? engine.value : null))
const offer = computed(() => (chosen.value ? state.models?.[chosen.value] : undefined))
// A model belongs to an engine: changing the engine clears a model the new one does not have.
watch(chosen, () => {
  if (model.value && !offer.value?.models.some((m) => m.id === model.value)) model.value = ''
  if (effort.value && offer.value && !offer.value.efforts.includes(effort.value)) effort.value = ''
})
</script>

<template>
  <div class="grid gap-3" :class="fixed ? 'grid-cols-2' : 'grid-cols-3'">
    <div v-if="!fixed">
      <label :for="`${id}-engine`" class="label">Engine</label>
      <select :id="`${id}-engine`" v-model="engine" class="field mt-1">
        <option :value="autoValue">{{ autoLabel }}</option>
        <option v-for="e in ['claude', 'codex', 'grok'] as const" :key="e" :value="e">{{ ENGINE_NAME[e] }}</option>
      </select>
    </div>
    <div>
      <label :for="`${id}-model`" class="label">Model</label>
      <select :id="`${id}-model`" v-model="model" class="field mt-1" :disabled="!chosen">
        <option value="">{{ chosen ? 'Default' : 'Pick an engine first' }}</option>
        <option v-for="m in offer?.models ?? []" :key="m.id" :value="m.id">{{ m.name }}</option>
        <option v-if="model && !offer?.models.some((m) => m.id === model)" :value="model">{{ model }}</option>
      </select>
    </div>
    <div>
      <label :for="`${id}-effort`" class="label">Effort</label>
      <select :id="`${id}-effort`" v-model="effort" class="field mt-1" :disabled="!chosen">
        <option value="">Default</option>
        <option v-for="e in offer?.efforts ?? []" :key="e" :value="e">{{ e }}</option>
        <option v-if="effort && !offer?.efforts.includes(effort)" :value="effort">{{ effort }}</option>
      </select>
    </div>
  </div>
</template>
