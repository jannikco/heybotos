<script setup lang="ts">
// What an agent wrote, set as text: paragraphs, lists, tables, code. `live` is for an answer that
// is still being written.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, settle } from '../markdown'

const props = defineProps<{ text: string; live?: boolean }>()
const html = computed(() => renderMarkdown(props.live ? settle(props.text) : props.text))
const root = ref<HTMLElement | null>(null)

// A table wider than its frame scrolls inside it; only then can the frame be reached with the keys.
function measure(): void {
  for (const frame of root.value?.querySelectorAll<HTMLElement>('.md-scroll') ?? []) {
    // Measured as a table that fits, since one that scrolls gives its long columns more room.
    frame.classList.remove('wide')
    const wide = frame.scrollWidth > frame.clientWidth + 1
    frame.classList.toggle('wide', wide)
    // The first column stays in view while the rest scrolls, unless it would take half the frame.
    const first = frame.querySelector<HTMLElement>('th, td')
    frame.classList.toggle('pin', wide && !!first && first.offsetWidth <= frame.clientWidth * 0.45)
    if (wide) {
      frame.tabIndex = 0
      frame.setAttribute('role', 'region')
      frame.setAttribute('aria-label', 'Table, scrolls sideways')
    } else {
      frame.removeAttribute('tabindex')
      frame.removeAttribute('role')
      frame.removeAttribute('aria-label')
    }
    edge(frame)
  }
}
/** Whether there is more of the table to the right of what shows. */
function edge(frame: HTMLElement): void {
  frame.parentElement?.classList.toggle('more', frame.scrollLeft + frame.clientWidth < frame.scrollWidth - 1)
}
function scrolled(e: Event): void {
  if ((e.target as HTMLElement).classList?.contains('md-scroll')) edge(e.target as HTMLElement)
}
let watcher: ResizeObserver | null = null
onMounted(() => {
  measure()
  watcher = new ResizeObserver(measure)
  watcher.observe(root.value!)
})
onBeforeUnmount(() => watcher?.disconnect())
watch(html, measure, { flush: 'post' })

const cell = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()

async function copy(e: MouseEvent): Promise<void> {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]')
  if (!button) return
  const was = button.dataset.copy === 'table' ? 'Copy table' : 'Copy'
  let text = ''
  if (button.dataset.copy === 'table') {
    // Tabs between cells, so it pastes into a spreadsheet as rows and columns.
    const rows = button.parentElement?.querySelectorAll('tr') ?? []
    text = [...rows].map((r) => [...r.querySelectorAll('th,td')].map(cell).join('\t')).join('\n')
  } else {
    text = button.parentElement?.querySelector('pre')?.innerText ?? ''
  }
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
  } catch {
    button.textContent = 'Could not copy'
  }
  window.setTimeout(() => (button.textContent = was), 1600)
}
</script>

<template>
  <div ref="root" class="prose-run" @click="copy" @scroll.capture.passive="scrolled" v-html="html"></div>
</template>
