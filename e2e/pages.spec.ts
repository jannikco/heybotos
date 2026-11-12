// Getting in, getting around, and the pages beside the conversations: projects, the team, and how
// it all holds up on a phone.
import { conversation, drawer, expect, jumpTo, newTaskDialog, sidebar, signIn, startTask, test } from './support.ts'

test('a browser that was not opened from the terminal gets the signed-out page and nothing else', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'This browser is not signed in' })).toBeVisible()
  await expect(page.getByText('heybotos open', { exact: true })).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)
  // A page deep inside the app is no way around it, and the daemon itself says no.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'This browser is not signed in' })).toBeVisible()
  expect((await page.request.get('/api/projects')).status()).toBe(401)
})

test('projects: find one, keep notes for workers, add a non-code project', async ({ page }) => {
  await signIn(page)
  await sidebar(page).getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Projects' }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  await expect(main.getByRole('link', { name: /^shop\b/ })).toContainText('The web shop for printed things')
  await expect(main.getByRole('link', { name: /^shop\b/ })).toContainText('Vue')
  await main.getByLabel('Find a project').fill('paper prices')
  await expect(main.getByRole('link', { name: /^price-notes\b/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /^shop\b/ })).toHaveCount(0)
  await main.getByLabel('Find a project').fill('no such thing')
  await expect(main.getByText('Nothing matches "no such thing".')).toBeVisible()

  await main.getByLabel('Find a project').fill('')
  await main.getByRole('link', { name: /^shop\b/ }).click()
  await expect(main.getByRole('heading', { name: 'shop', exact: true })).toBeVisible()
  await main.getByLabel('Notes for workers').fill('Never deploy on a Friday.')
  await main.getByRole('button', { name: 'Save notes' }).click()
  await expect(main.getByText('Notes saved.')).toBeVisible()
  await page.reload()
  await expect(main.getByLabel('Notes for workers')).toHaveValue('Never deploy on a Friday.')

  await main.getByRole('link', { name: 'All projects' }).click()
  await main.getByRole('button', { name: 'Add a project' }).click()
  await main.getByLabel('Name', { exact: true }).fill('Move the office')
  await main.getByLabel('What it is about').fill('Everything about moving to the new address.')
  await main.getByRole('button', { name: 'Add project' }).click()
  await expect(main.getByRole('heading', { name: 'Move the office' })).toBeVisible()
  await expect(main.getByText('Everything about moving to the new address.')).toBeVisible()
  await expect(main.getByText('No task has been given to a worker in this project yet.')).toBeVisible()

  // A task from here is for this project, and the project has a conversation of its own to open.
  await main.getByRole('button', { name: 'New task here' }).click()
  await expect(newTaskDialog(page).getByLabel('Project')).toHaveValue('Move the office')
  await newTaskDialog(page).getByRole('button', { name: 'Cancel' }).click()
  await jumpTo(page, 'move office', 'Move the office')
  const chat = conversation(page, 'Move the office')
  await expect(chat.getByText('Nothing has happened here yet.')).toBeVisible()
  await chat.getByRole('link', { name: 'Project', exact: true }).click()
  await expect(main.getByRole('heading', { name: 'Move the office' })).toBeVisible()
})

test('the command palette jumps to a project, and a team member opens from the sidebar', async ({ page }) => {
  await signIn(page)

  // Cmd+K from anywhere, even with the cursor in the message box.
  await expect(conversation(page, 'Manager').getByLabel('Message to the manager')).toBeFocused()
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Find or run anything' })
  const search = palette.getByRole('combobox', { name: 'Search' })
  await expect(search).toBeFocused()
  // Without a query it lists people and commands, not every project.
  await expect(palette.getByRole('option', { name: /^Manager\b/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /\bInbox\b/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /^shop\b/ })).toHaveCount(0)
  await search.fill('nothing like this')
  await expect(palette.getByText('Nothing matches "nothing like this".')).toBeVisible()
  await search.fill('price')
  await expect(palette.getByRole('option').first()).toContainText('price-notes')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/t\/price-notes$/)
  await expect(conversation(page, 'price-notes').getByRole('heading', { name: 'price-notes', level: 1 })).toBeVisible()

  // Arrow keys move through the hits; Escape closes it without going anywhere.
  await page.keyboard.press('Meta+k')
  await search.fill('s')
  await page.keyboard.press('ArrowDown')
  await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/t\/price-notes$/)
  // The button above the conversations opens the same thing.
  await sidebar(page).getByRole('button', { name: 'Find or run anything' }).click()
  await expect(search).toBeFocused()
  await search.fill('health')
  await palette.getByRole('option', { name: /\bHealth\b/ }).click()
  await expect(page.getByRole('heading', { name: 'Health', level: 1 })).toBeVisible()
  await expect(page.getByRole('main').getByText('Ready', { exact: true })).toHaveCount(3)

  // A member of the team: who they are, and what they have done.
  await sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: /^Wren, Writer/ }).click()
  await expect(page).toHaveURL(/\/team\/wren$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Wren', level: 1 })).toBeVisible()
  const who = main.getByRole('form', { name: 'Who Wren is' })
  await expect(who.getByLabel('Role')).toHaveValue('Writer')
  await expect(who.getByRole('checkbox', { name: 'Writing' })).toBeChecked()
  await who.getByLabel('How Wren works').fill('You write for one reader and keep it short.')
  await who.getByRole('button', { name: 'Save' }).click()
  await expect(who.getByRole('status')).toHaveText('Saved.')

  // A task given from their page is theirs, whatever kind of work it is.
  const work = main.getByRole('region', { name: "Wren's work" })
  await main.getByRole('button', { name: 'Give Wren a task' }).click()
  await expect(newTaskDialog(page).getByLabel('Who does it')).toHaveValue('wren')
  const panel = await startTask(page, 'Tidy up the supplier notes.', { project: 'price-notes' })
  const card = conversation(page, 'price-notes').getByRole('article', { name: 'Task: Tidy up the supplier notes.' })
  await expect(card).toContainText('Wren · Writer')
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText('Done')
  await sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: /^Wren, Writer/ }).click()
  await expect(work.getByRole('article', { name: 'Task: Tidy up the supplier notes.' })).toBeVisible()
  await expect(who.getByLabel('How Wren works')).toHaveValue('You write for one reader and keep it short.')
})

test('the page never scrolls sideways at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  /** Anything a finger could drag sideways: the page itself, or a pane that fills most of the screen. */
  const sideways = () =>
    page.evaluate(() => {
      const out: string[] = []
      const root = document.documentElement
      if (root.scrollWidth > root.clientWidth) out.push('the page')
      for (const el of document.querySelectorAll('body *')) {
        if (el.clientHeight < window.innerHeight / 2 || el.scrollWidth <= el.clientWidth + 1) continue
        if (['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) out.push(`${el.tagName.toLowerCase()}.${el.className}`)
      }
      return out
    })

  // On a phone the conversation fills the screen, and the list of conversations is a screen of its own.
  const chat = conversation(page, 'Manager')
  await expect(chat.getByLabel('Message to the manager')).toBeVisible()
  await expect(sidebar(page)).toBeHidden()
  await chat.getByRole('link', { name: 'All conversations' }).click()
  await expect(sidebar(page)).toBeVisible()
  await expect(chat).toBeHidden()
  expect(await sideways(), '/list').toEqual([])
  await sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: 'Manager, leads the team' }).click()
  await expect(chat).toBeVisible()

  const pages: Array<[path: string, heading: string]> = [
    ['/t/chief', 'Manager'],
    ['/t/shop', 'shop'],
    ['/inbox', 'Inbox'],
    ['/agents', 'Agents'],
    ['/board', 'Board'],
    ['/projects', 'Projects'],
    ['/projects/shop', 'shop'],
    ['/routines', 'Routines'],
    ['/usage', 'Usage'],
    ['/health', 'Health'],
    ['/settings', 'Settings'],
    ['/settings/manager', 'Settings'],
    ['/settings/team', 'Settings'],
    ['/settings/engines', 'Settings'],
    ['/settings/connectors', 'Settings'],
    ['/settings/safety', 'Settings'],
    ['/team/ada', 'Ada'],
    ['/t/price-notes', 'price-notes'],
  ]
  for (const [path, heading] of pages) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle').catch(() => {})
    expect(await sideways(), path).toEqual([])
  }

  // The same with the new-task dialog open, and with a task open over the conversation.
  await conversation(page, 'price-notes').getByRole('button', { name: 'New task' }).click()
  await expect(newTaskDialog(page).getByLabel('Project')).toHaveValue('price-notes')
  expect(await sideways(), 'the new-task dialog').toEqual([])
  const panel = await startTask(page, 'Check the notes on a phone.')
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  expect(await sideways(), 'a task open over the conversation').toEqual([])
  await drawer(page).getByRole('link', { name: 'Close details' }).click()
  await expect(panel).toBeHidden()
  expect(await sideways(), 'the conversation with a task in it').toEqual([])
})
