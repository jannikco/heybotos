// What the settings pages share: the settings as the daemon holds them, a way to change one thing
// and have it saved at once, and the lists several sections look at (connectors, usage, models).
import { onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import type { ConnectorView, Engine, EngineModels, EngineUsage, SettingsPatch, SettingsView } from '@heybotos/protocol'
import { api, type ApiError } from './api'
import { loadProjects, state } from './store'

export const settings = ref<SettingsView | null>(null)
export const connectors = ref<ConnectorView[]>([])
export const usage = ref<EngineUsage[] | null>(null)

/** `mark` is the word shown beside the page title after a save; `errors` holds what was refused, by setting. */
export const saving = reactive({ mark: '', errors: {} as Record<string, string> })

let markTimer = 0
export function saved(words = 'Saved'): void {
  saving.mark = words
  window.clearTimeout(markTimer)
  markTimer = window.setTimeout(() => (saving.mark = ''), 2400)
}
export function clearErrors(): void {
  for (const k of Object.keys(saving.errors)) delete saving.errors[k]
}

export async function loadSettings(): Promise<void> {
  settings.value = (await api<{ settings: SettingsView }>('/api/settings')).settings
}

// Changes go out one after the other, so an answer never overwrites a newer one.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Save one change. `key` names the setting, so a refusal shows up beside it. Resolves to whether it
 * was saved; when it was not, the settings stay as the daemon has them.
 */
export function change(key: string, patch: SettingsPatch): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    try {
      settings.value = (await api<{ settings: SettingsView }>('/api/settings', { method: 'PUT', body: patch })).settings
      // A refusal beside a setting is over once that setting, or one of its kind, went through.
      const kind = key.split('.')[0]
      for (const k of Object.keys(saving.errors)) if (k.split('.')[0] === kind) delete saving.errors[k]
      if (state.me) {
        state.me.managerName = settings.value.manager.name
        state.me.maxWorkers = settings.value.general.maxWorkers
      }
      if (patch.general?.projectRoots) void loadProjects(true).catch(() => {})
      saved()
      return true
    } catch (e) {
      saving.errors[key] = (e as ApiError).message
      return false
    }
  }
  const next = queue.then(run, run)
  queue = next
  return next
}

/**
 * A text field that saves itself: a little after the typing stops, or when the field is left.
 * What the daemon says is shown again as long as nothing unsaved is in the field.
 */
export function useDraft(source: () => string, commit: (value: string) => unknown, wait = 900): { text: Ref<string>; touch: () => void; flush: () => void } {
  const text = ref(source())
  let dirty = false
  let timer = 0
  watch(source, (v) => {
    if (!dirty) text.value = v
  })
  function flush(): void {
    window.clearTimeout(timer)
    if (!dirty) return
    dirty = false
    if (text.value.trim() !== source()) void commit(text.value.trim())
  }
  function touch(): void {
    dirty = true
    window.clearTimeout(timer)
    timer = window.setTimeout(flush, wait)
  }
  onBeforeUnmount(flush)
  return { text, touch, flush }
}

export async function loadConnectors(): Promise<void> {
  connectors.value = (await api<{ list: ConnectorView[] }>('/api/connectors')).list
}
export function putConnector(c: ConnectorView): void {
  const i = connectors.value.findIndex((x) => x.name === c.name)
  if (i >= 0) connectors.value[i] = c
  else connectors.value = [...connectors.value, c].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadUsage(): Promise<void> {
  usage.value = (await api<{ engines: EngineUsage[] }>('/api/usage')).engines
}

/** The models and effort levels each engine offers on the owner's plan; asked for once. */
export async function ensureModels(): Promise<void> {
  if (!state.models) state.models = (await api<{ models: Record<Engine, EngineModels> }>('/api/models').catch(() => null))?.models ?? null
}
