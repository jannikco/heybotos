import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { command } from './store'
import './style.css'

declare global {
  interface Window {
    /** Present when the page runs inside the HeyBotOS desktop app. */
    heybotosDesktop?: {
      quickDone(): void
      quickCancel(): void
      onNavigate(fn: (path: string) => void): void
      onCommand(fn: (name: string) => void): void
      pickFolder?(): Promise<string | null>
      installUpdate?(): Promise<{ ok: boolean; problem?: string }>
    }
  }
}

// The desktop shell steers the page: its menus, shortcuts and notification clicks land here.
window.heybotosDesktop?.onNavigate((path) => void router.push(path))
window.heybotosDesktop?.onCommand((name) => command(name))

// A file dropped beside the place that takes it would otherwise replace the whole page with that file.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault()
  })
}

createApp(App).use(router).mount('#app')
