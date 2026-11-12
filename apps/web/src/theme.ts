// The look: dark, light, or whatever the Mac is set to. Kept in this browser only.
import { ref } from 'vue'

export type ThemeChoice = 'dark' | 'light' | 'system'

const KEY = 'heybotos-theme'

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'system') return v
  } catch {
    /* no storage: dark */
  }
  return 'dark'
}

export const themeChoice = ref<ThemeChoice>(stored())

const systemLight = () => window.matchMedia('(prefers-color-scheme: light)').matches
/** What is on screen right now. */
export const isLight = () => (themeChoice.value === 'system' ? systemLight() : themeChoice.value === 'light')

function apply(): void {
  if (isLight()) document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
}

export function setTheme(choice: ThemeChoice): void {
  themeChoice.value = choice
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    /* the choice just does not stick */
  }
  apply()
}

let started = false
/** Apply the stored choice, and follow the Mac when it is set to "system". */
export function startTheme(): void {
  apply()
  if (started) return
  started = true
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themeChoice.value === 'system') apply()
  })
}
