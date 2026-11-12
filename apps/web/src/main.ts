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
    }
  }
}

// The desktop shell steers the page: its menus, shortcuts and notification clicks land here.
window.heybotosDesktop?.onNavigate((path) => void router.push(path))
window.heybotosDesktop?.onCommand((name) => command(name))

createApp(App).use(router).mount('#app')
