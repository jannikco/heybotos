<script setup lang="ts">
// The model or the effort level for one engine, from what that engine really offers on the plan.
import { computed, onMounted } from 'vue'
import type { Engine } from '@heybotos/protocol'
import { ensureModels } from '../../settings'
import { state } from '../../store'

const value = defineModel<string>({ required: true })
const props = defineProps<{ engine: Engine; what: 'model' | 'effort'; label: string; id?: string }>()

onMounted(() => void ensureModels())
const offer = computed(() => state.models?.[props.engine])
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
const options = computed(() => (props.what === 'model' ? (offer.value?.models ?? []).map((m) => ({ id: m.id, name: m.name })) : (offer.value?.efforts ?? []).map((e) => ({ id: e, name: cap(e) }))))
/** "Default" says which model that is, when the engine tells. */
const usual = computed(() => {
  if (props.what !== 'model') return 'Default'
  const d = offer.value?.models.find((m) => m.id === offer.value?.defaultModel)
  return d ? `Default (${d.name})` : 'Default'
})
</script>

<template>
  <select :id="id" v-model="value" class="field" :aria-label="label">
    <option value="">{{ usual }}</option>
    <option v-for="o in options" :key="o.id" :value="o.id">{{ o.name }}</option>
    <option v-if="value && !options.some((o) => o.id === value)" :value="value">{{ value }}</option>
  </select>
</template>
