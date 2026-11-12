// Shared by every browser test: the signed-in page, the handful of things a person does over and
// over (give a task, jump somewhere with the palette), and the rule that no test passes with an
// uncaught error in the page.
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { E2E_HOME } from '../playwright.config.ts'

export { expect, E2E_HOME }
export type { Locator, Page }

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await use(errors)
      expect(errors, 'uncaught errors in the page').toEqual([])
    },
    { auto: true },
  ],
})

/** A file in one of the demo's two project folders. */
export const inProject = (project: 'shop' | 'price-notes', ...parts: string[]) => join(E2E_HOME, 'code', project, ...parts)

/** How many times a demo worker really got through to a server (the stand-in ssh notes every call). */
export function serverCalls(): number {
  const log = join(E2E_HOME, 'ssh-calls.txt')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('deploy@web1')).length : 0
}

/** Open the single-use sign-in link the daemon wrote, landing on `then` (the general conversation by default). */
export async function signIn(page: Page, then = '/'): Promise<void> {
  const link = readFileSync(join(E2E_HOME, 'state', 'login-url'), 'utf8').trim()
  await page.goto(then === '/' ? link : `${link}&next=${encodeURIComponent(then)}`)
  // On a narrow window the conversations are a screen of their own, so either one counts.
  await expect(page.getByRole('main').or(sidebar(page)).first()).toBeVisible()
}

/** The left side: the team on top, one conversation per project below, more pages at the bottom. */
export const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Conversations' })
/** The task open beside a conversation. */
export const drawer = (page: Page) => page.getByRole('complementary', { name: 'Agent details' })
/** A conversation: with the manager ("Manager"), or a project's. */
export const conversation = (page: Page, name: string) => page.getByRole('region', { name: `Conversation with ${name}` })
/** A project's conversation in the list on the left. */
export const inList = (page: Page, project: string) => sidebar(page).getByRole('listitem').getByRole('link', { name: new RegExp(`^${project}\\b`) })

export const newTaskDialog = (page: Page) => page.getByRole('dialog', { name: 'Give a worker a task' })

/**
 * Who does the work. Left to itself HeyBotOS spreads tasks over the engines, and in the demo only the
 * stand-in for Claude takes its time, changes files in `shop` and tries the server from a folder
 * with a `.demo-upload` file, so a test that needs any of that names it.
 */
export type EngineName = 'Claude' | 'Codex' | 'Grok'

/** Fill in the new-task dialog that is open and start the task; resolves with the drawer showing it. */
export async function startTask(page: Page, brief: string, how: { project?: string; engine?: EngineName } = {}): Promise<Locator> {
  const dialog = newTaskDialog(page)
  if (how.project) await dialog.getByLabel('Project').fill(how.project)
  if (how.engine) await dialog.getByLabel('Engine', { exact: true }).selectOption({ label: how.engine })
  await dialog.getByLabel('What should it achieve?').fill(brief)
  await dialog.getByRole('button', { name: 'Start task' }).click()
  await expect(drawer(page).getByRole('heading', { name: brief })).toBeVisible()
  return drawer(page)
}

/** Give a task with the + button above the conversations. */
export async function giveTask(page: Page, project: string, brief: string, engine?: EngineName): Promise<Locator> {
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  return startTask(page, brief, { project, engine })
}

/** Cmd+K, type, Enter: the first hit is where it goes. */
export async function jumpTo(page: Page, query: string, firstHit: string | RegExp = query): Promise<void> {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Find or run anything' })
  await palette.getByRole('combobox', { name: 'Search' }).fill(query)
  await expect(palette.getByRole('option').first()).toContainText(firstHit)
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
}
