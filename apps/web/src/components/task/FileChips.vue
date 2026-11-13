<script setup lang="ts">
// Attached files: pictures as small previews that open large, everything else as a chip that
// downloads. `removable` adds a way to take one off.
import { ref } from 'vue'
import type { FileView } from '@heybotos/protocol'
import { sizeWords } from '../../tracker'

defineProps<{ files: FileView[]; removable?: boolean; small?: boolean; end?: boolean }>()
defineEmits<{ remove: [id: string] }>()

const shown = ref<FileView | null>(null)
const box = ref<HTMLDialogElement | null>(null)
function show(f: FileView): void {
  shown.value = f
  box.value?.showModal()
}
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4) : 'file')
</script>

<template>
  <ul v-if="files.length" class="files" :class="{ small, end }" aria-label="Attached files">
    <li v-for="f in files" :key="f.id" class="file" :class="{ pic: f.image }">
      <button v-if="f.image" type="button" class="thumb" :aria-label="`Open ${f.name}`" @click="show(f)">
        <img :src="`/api/files/${f.id}`" :alt="f.name" loading="lazy" />
      </button>
      <a v-else class="doc" :href="`/api/files/${f.id}`" :download="f.name" :aria-label="`Download ${f.name}, ${sizeWords(f.size)}`">
        <span class="ext" aria-hidden="true">{{ ext(f.name) }}</span>
        <span class="min-w-0">
          <span class="block truncate font-medium">{{ f.name }}</span>
          <span class="text-ink-3 block text-xs">{{ sizeWords(f.size) }}</span>
        </span>
      </a>
      <button v-if="removable" type="button" class="off" :aria-label="`Remove ${f.name}`" @click="$emit('remove', f.id)">×</button>
    </li>
  </ul>
  <dialog ref="box" class="light" aria-label="Picture" @click="box?.close()" @close="shown = null">
    <figure v-if="shown">
      <img :src="`/api/files/${shown.id}`" :alt="shown.name" />
      <figcaption>
        <span class="truncate">{{ shown.name }}</span>
        <span class="text-ink-3">{{ sizeWords(shown.size) }}</span>
        <a class="btn" :href="`/api/files/${shown.id}`" :download="shown.name" @click.stop>Download</a>
        <button type="button" class="btn" @click.stop="box?.close()">Close</button>
      </figcaption>
    </figure>
  </dialog>
</template>

<style scoped>
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.files.end {
  justify-content: flex-end;
}
.file {
  position: relative;
  min-width: 0;
}
.thumb {
  display: block;
  width: 7rem;
  height: 5rem;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--sunken);
}
.small .thumb {
  width: 4.5rem;
  height: 3.25rem;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb:hover {
  border-color: var(--ink-3);
}
.doc {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  height: 5rem;
  max-width: 15rem;
  padding: 0 0.8rem 0 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
}
.small .doc {
  height: 3.25rem;
}
.doc:hover {
  border-color: var(--ink-3);
}
.ext {
  display: grid;
  place-items: center;
  flex: none;
  width: 2.1rem;
  height: 2.5rem;
  border-radius: 5px;
  background: var(--sunken);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: lowercase;
}
.small .ext {
  height: 2rem;
}
.off {
  position: absolute;
  top: -0.35rem;
  right: -0.35rem;
  display: grid;
  place-items: center;
  width: 1.2rem;
  height: 1.2rem;
  border-radius: 999px;
  background: var(--raised);
  border: 1px solid var(--line);
  color: var(--ink-2);
  line-height: 1;
}
.off:hover {
  color: var(--bad);
  border-color: var(--bad);
}
.light {
  margin: auto;
  padding: 0;
  max-width: min(92vw, 80rem);
  background: transparent;
  overflow: visible;
}
.light::backdrop {
  background: rgba(0, 0, 0, 0.75);
}
.light img {
  display: block;
  max-width: min(92vw, 80rem);
  max-height: 82vh;
  border-radius: 8px;
  background: var(--surface);
}
.light figcaption {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.6rem;
  color: #fff;
}
.light figcaption .truncate {
  flex: 1;
  min-width: 0;
}
</style>
