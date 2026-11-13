// Settings: a rail of sections, every change saved as it is made. The demo starts with two
// connectors: `shop`, a program that answers with one tool that looks and one that changes
// something, and `crm`, a web address where nothing answers.
import { expect, newTaskDialog, sidebar, signIn, test, type Page } from './support.ts'

const rail = (page: Page) => page.getByRole('navigation', { name: 'Settings' })
/** The word beside the page title after a change went through. */
const savedMark = (page: Page) => page.getByRole('status', { name: 'Saving' })

async function openSettings(page: Page, section: RegExp | string): Promise<void> {
  await sidebar(page).getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await rail(page).getByRole('link', { name: section }).click()
}

type Stored = {
  general: { maxWorkers: number; notifications: boolean; projectRoots: string[] }
  manager: { name: string }
  routing: { mode: string; pool: string[]; byKind: Record<string, string>; headroom: Record<string, number> }
  gate: { alwaysAllowTools: string[] }
}
const stored = async (page: Page) => ((await (await page.request.get('/api/settings')).json()) as { settings: Stored }).settings

test('connectors: see which ones answer and what they offer, add, switch off, and offer them to a new task', async ({ page }) => {
  await signIn(page)
  await openSettings(page, /^Connectors/)
  const panel = page.getByRole('region', { name: 'Connectors' })
  await expect(panel.getByRole('heading', { name: 'Connectors', level: 2 })).toBeVisible()
  const opener = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}, `) })
  const rows = panel.locator('ul.set-panel > li')
  const row = (name: string) => rows.filter({ has: opener(name) })
  const shop = row('shop')
  const crm = row('crm')

  // One answers, the other does not.
  await expect(panel.getByText('1 of 2 answering')).toBeVisible()
  await expect(shop.getByRole('img', { name: '2 tools' })).toBeVisible()
  await expect(crm.getByRole('img', { name: 'Not answering' })).toBeVisible()
  await expect(crm.getByText('Not answering')).toBeVisible()

  // Opened, the one that answers lists its tools: looking goes straight through, changing asks.
  await expect(shop.getByRole('button', { name: 'shop, node fake-connector.mjs' })).toHaveAttribute('aria-expanded', 'false')
  await shop.locator(opener('shop')).click()
  await expect(shop.locator(opener('shop'))).toHaveAttribute('aria-expanded', 'true')
  await expect(shop.getByRole('group', { name: 'shop: looks things up' })).toContainText('search-orders')
  const changes = shop.getByRole('group', { name: 'shop: changes things' })
  await expect(changes).toContainText('waits for your yes')
  await expect(changes.getByRole('listitem')).toHaveText(/^\s*create-order\s*asks\s*$/)
  await expect(shop.getByText('A program on this Mac')).toBeVisible()

  // One tool that changes something can be let through, right where it is listed.
  const allow = changes.getByRole('switch', { name: 'Allow shop create-order without asking' })
  await expect(allow).not.toBeChecked()
  await allow.click()
  await expect(allow).toBeChecked()
  await expect(savedMark(page)).toHaveText('Saved')
  await expect(changes).toContainText('1 allowed without asking')
  await expect(changes.getByRole('listitem')).toHaveText(/^\s*create-order\s*allowed\s*$/)
  expect((await stored(page)).gate.alwaysAllowTools).toEqual(['shop/create-order'])
  // Safety lists what was let through, and takes it back.
  await rail(page).getByRole('link', { name: 'Safety' }).click()
  const let_through = page.getByRole('list', { name: 'Connector changes allowed without asking' })
  await expect(let_through.getByRole('listitem')).toHaveText(/shop: create-order/)
  await let_through.getByRole('button', { name: 'Make shop: create-order ask again' }).click()
  await expect(page.getByText('None. Every change through a connector waits for your yes.')).toBeVisible()
  expect((await stored(page)).gate.alwaysAllowTools).toEqual([])
  await rail(page).getByRole('link', { name: /^Connectors/ }).click()
  await shop.locator(opener('shop')).click()
  await expect(allow).not.toBeChecked()

  // The other one says why it could not be reached, and asking again does not change that.
  await crm.locator(opener('crm')).click()
  await expect(shop.getByRole('group', { name: 'shop: looks things up' })).toBeHidden()
  await expect(crm.getByRole('alert')).not.toBeEmpty()
  await expect(crm.getByText('At a web address')).toBeVisible()
  await crm.getByRole('button', { name: 'Check', exact: true }).click()
  await expect(crm.getByRole('button', { name: 'Check', exact: true })).toBeEnabled()
  await expect(crm.getByText('Not answering')).toBeVisible()

  // Adding one happens in a dialog. A name with nothing to go by is refused, in words.
  const form = page.getByRole('dialog', { name: 'Add a connector' })
  await expect(form).toBeHidden()
  await panel.getByRole('button', { name: 'Add connector' }).click()
  await form.getByLabel('Name').fill('?!')
  await form.getByLabel('Web address, or the command that starts it').fill('http://127.0.0.1:9/nothing')
  await form.getByRole('button', { name: 'Add connector' }).click()
  await expect(form.getByRole('alert')).toHaveText('A connector name needs at least one letter or digit, like "shop" or "My CRM".')
  await expect(rows).toHaveCount(2)

  // A good name is saved even when nothing answers there yet; then it is removed again.
  // Typed with a space, it is kept with a dash: the form every engine takes.
  await form.getByLabel('Name').fill('team notes')
  await form.getByRole('button', { name: 'Add connector' }).click()
  await expect(form).toBeHidden()
  await expect(panel.getByRole('status')).toContainText('team-notes is saved, but it did not answer')
  const notes = row('team-notes')
  await expect(notes.getByText('Not answering')).toBeVisible()
  await expect(panel.getByText('1 of 3 answering')).toBeVisible()
  // The dialog opens empty the next time.
  await panel.getByRole('button', { name: 'Add connector' }).click()
  await expect(form.getByLabel('Name')).toHaveValue('')
  await form.getByRole('button', { name: 'Cancel' }).click()
  await expect(form).toBeHidden()
  await notes.locator(opener('team-notes')).click()
  page.once('dialog', (d) => {
    expect(d.message()).toContain('Remove the connector "team-notes"?')
    void d.accept()
  })
  await notes.getByRole('button', { name: 'Remove' }).click()
  await expect(notes).toHaveCount(0)
  await expect(panel.getByText('1 of 2 answering')).toBeVisible()

  // The new-task dialog offers the connectors that are switched on.
  const offered = newTaskDialog(page).getByRole('group', { name: 'Connectors it may use' })
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  await expect(offered.getByRole('checkbox', { name: 'shop' })).not.toBeChecked()
  await expect(offered.getByRole('checkbox', { name: 'crm' })).not.toBeChecked()
  await newTaskDialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(newTaskDialog(page)).toBeHidden()

  // Switched off, a connector is no longer offered; switched on, it is back.
  const use = crm.getByRole('switch', { name: 'Use crm' })
  await expect(use).toBeChecked()
  await use.click()
  await expect(use).not.toBeChecked()
  await expect(crm.getByRole('img', { name: 'Switched off' })).toBeVisible()
  await expect(crm.getByRole('button', { name: 'Check', exact: true })).toBeDisabled()
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  await expect(offered.getByRole('checkbox', { name: 'shop' })).toBeVisible()
  await expect(offered.getByRole('checkbox', { name: 'crm' })).toHaveCount(0)
  await newTaskDialog(page).getByRole('button', { name: 'Cancel' }).click()

  await use.click()
  await expect(use).toBeChecked()
  await expect(crm.getByText('Not answering')).toBeVisible()
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  await expect(offered.getByRole('checkbox', { name: 'crm' })).toBeVisible()
  await newTaskDialog(page).getByRole('button', { name: 'Cancel' }).click()
})

test('general and the manager: a change is saved as it is made, and a refused one says why', async ({ page }) => {
  await signIn(page)
  const before = await stored(page)
  try {
    await openSettings(page, 'General')
    await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible()
    // No save button anywhere: the number is stored the moment it changes.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    const workers = page.getByRole('spinbutton', { name: 'Workers at once' })
    await expect(workers).toHaveValue(String(before.general.maxWorkers))
    await page.getByRole('button', { name: 'Workers at once: one more' }).click()
    await expect(workers).toHaveValue(String(before.general.maxWorkers + 1))
    await expect(savedMark(page)).toHaveText('Saved')
    expect((await stored(page)).general.maxWorkers).toBe(before.general.maxWorkers + 1)
    await page.reload()
    await expect(workers).toHaveValue(String(before.general.maxWorkers + 1))
    // Typed, a number is kept inside its limits.
    await workers.fill('40')
    await workers.press('Enter')
    await expect(workers).toHaveValue('12')
    await expect(page.getByRole('button', { name: 'Workers at once: one more' })).toBeDisabled()
    await workers.fill(String(before.general.maxWorkers))
    await workers.press('Enter')
    await expect.poll(async () => (await stored(page)).general.maxWorkers).toBe(before.general.maxWorkers)

    const notify = page.getByRole('switch', { name: 'Notifications' })
    const wasOn = before.general.notifications
    await notify.click()
    await expect(notify).toBeChecked({ checked: !wasOn })
    await expect.poll(async () => (await stored(page)).general.notifications).toBe(!wasOn)
    await notify.press('Space')
    await expect(notify).toBeChecked({ checked: wasOn })

    // A folder that is not a full path is refused in words; what was typed stays to be corrected.
    const folders = page.getByRole('list', { name: 'Project folders' })
    const addFolder = page.getByRole('form', { name: 'Add folder' })
    await expect(folders.getByRole('listitem')).toHaveCount(before.general.projectRoots.length)
    await addFolder.getByRole('textbox').fill('code/here')
    await addFolder.getByRole('button', { name: 'Add folder' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'not a full folder path' })).toHaveText('"code/here" is not a full folder path. Start it with / or ~.')
    await expect(addFolder.getByRole('textbox')).toHaveValue('code/here')
    await expect(folders.getByRole('listitem')).toHaveCount(before.general.projectRoots.length)

    // The look is this browser's own choice, and it sticks.
    const html = page.locator('html')
    await expect(html).not.toHaveAttribute('data-theme', 'light')
    const looks = page.getByRole('radiogroup', { name: 'Look' })
    await looks.getByText('Light', { exact: true }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked()
    await looks.getByText('Dark', { exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await expect(html).not.toHaveAttribute('data-theme', 'light')

    // The manager's name is saved when the field is left, and shows everywhere at once.
    await rail(page).getByRole('link', { name: 'Manager' }).click()
    await expect(page.getByRole('heading', { name: 'Manager', level: 2 })).toBeVisible()
    const name = page.getByLabel('Name', { exact: true })
    await name.fill('Head of Ops')
    await name.blur()
    await expect(page.getByRole('heading', { name: 'Head of Ops', level: 2 })).toBeVisible()
    await expect(rail(page).getByRole('link', { name: 'Head of Ops' })).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: 'Head of Ops, leads the team' })).toBeVisible()
    await name.fill('Manager')
    await name.press('Enter')
    await expect(page.getByRole('heading', { name: 'Manager', level: 2 })).toBeVisible()
  } finally {
    await page.request.put('/api/settings', { data: { general: { maxWorkers: before.general.maxWorkers, notifications: before.general.notifications }, manager: { name: before.manager.name } } })
  }
})

test('engines: move the hold-back mark with the keys, choose who shares the work, route by kind of work', async ({ page }) => {
  await signIn(page)
  const before = await stored(page)
  try {
    await openSettings(page, /^Engines/)
    const claude = page.getByRole('region', { name: 'Claude' })
    const codex = page.getByRole('region', { name: 'Codex' })
    await expect(claude.getByRole('img', { name: 'Ready' })).toBeVisible()

    // The mark on the usage bar is the setting: arrow keys move it one percent at a time.
    const mark = claude.getByRole('slider', { name: 'Claude: hold new workers back above' })
    const at = Math.round(before.routing.headroom.claude! * 100)
    await expect(mark).toHaveAttribute('aria-valuenow', String(at))
    await mark.focus()
    await mark.press('ArrowLeft')
    await mark.press('ArrowLeft')
    await expect(mark).toHaveAttribute('aria-valuenow', String(at - 2))
    await expect(claude.getByText(`New workers wait once a limit passes ${at - 2}%`)).toBeVisible()
    await expect.poll(async () => (await stored(page)).routing.headroom.claude).toBe((at - 2) / 100)
    await mark.press('Home')
    await expect(mark).toHaveAttribute('aria-valuenow', '50')
    await mark.press('End')
    await expect(mark).toHaveAttribute('aria-valuenow', '100')
    await expect(claude.getByText('New workers are never held back on Claude.')).toBeVisible()
    await expect.poll(async () => (await stored(page)).routing.headroom.claude).toBe(1)
    // An engine that does not tell how full its plan is has no bar to put a mark on.
    await expect(codex.getByRole('slider')).toHaveCount(0)
    await expect(codex.getByText('Codex does not tell how much of the plan is used.')).toBeVisible()

    // At least one engine has to share the work: the last one cannot be switched off.
    const shares = (engine: string) => page.getByRole('switch', { name: `${engine} shares the work` })
    await shares('Grok').click()
    await expect(shares('Grok')).not.toBeChecked()
    await shares('Codex').click()
    await expect(shares('Codex')).not.toBeChecked()
    await shares('Claude').click()
    await expect(claude.getByRole('alert')).toHaveText('At least one engine has to take work.')
    await expect(shares('Claude')).toBeChecked()
    expect((await stored(page)).routing.pool).toEqual(['claude'])
    await shares('Codex').click()
    await shares('Grok').click()
    await expect.poll(async () => (await stored(page)).routing.pool).toEqual(['claude', 'codex', 'grok'])

    // By kind of work: a grid with one engine per kind.
    await expect(page.getByRole('table', { name: 'Which engine does which kind of work' })).toHaveCount(0)
    const spread = page.getByRole('radiogroup', { name: 'How work is spread' })
    await spread.getByText('By kind of work', { exact: true }).click()
    await expect(spread.getByRole('radio', { name: 'By kind of work' })).toBeChecked()
    const grid = page.getByRole('table', { name: 'Which engine does which kind of work' })
    await expect(grid).toBeVisible()
    await expect(shares('Claude')).toHaveCount(0)
    const other = before.routing.byKind.research === 'grok' ? 'Codex' : 'Grok'
    await grid.getByRole('radio', { name: `Research: ${other}` }).check()
    await expect.poll(async () => (await stored(page)).routing.byKind.research).toBe(other.toLowerCase())
    await page.reload()
    await expect(grid.getByRole('radio', { name: `Research: ${other}` })).toBeChecked()
    await spread.getByText('Automatic', { exact: true }).click()
    await expect(grid).toHaveCount(0)
  } finally {
    await page.request.put('/api/settings', { data: { routing: before.routing } })
  }
})

test('team: add a member whose face shows as you type, and take one off duty', async ({ page }) => {
  await signIn(page)
  await openSettings(page, /^Team/)
  const members = page.getByRole('region', { name: 'Team members' })
  await expect(members.getByRole('link', { name: 'Ada, Engineer' })).toBeVisible()

  const add = members.getByRole('form', { name: 'Add a team member' })
  await add.getByLabel("New member's name").fill('Nova')
  await add.getByLabel('Role').fill('Designer')
  await add.getByRole('button', { name: 'Add to the team' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'joined the team' })).toHaveText('Nova joined the team. Open them to shape how they work.')
  await expect(members.getByRole('link', { name: 'Nova, Designer' })).toBeVisible()
  await expect(add.getByLabel("New member's name")).toHaveValue('')
  const inSidebar = sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: /^Nova/ })
  await expect(inSidebar).toBeVisible()

  // The same name twice is refused.
  await add.getByLabel("New member's name").fill('nova')
  await add.getByLabel('Role').fill('Painter')
  await add.getByRole('button', { name: 'Add to the team' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'already' })).toHaveText('There is already a team member called "nova".')

  // Off duty, a member leaves the sidebar but stays on this list, greyed, to be switched on again.
  const duty = members.getByRole('switch', { name: 'Nova takes work' })
  await expect(duty).toBeChecked()
  await duty.click()
  await expect(duty).not.toBeChecked()
  await expect(inSidebar).toHaveCount(0)
  await expect(members.getByRole('listitem').filter({ hasText: 'Nova' })).toContainText('Off duty')
  // The row opens the member's own page.
  await members.getByRole('link', { name: 'Nova, Designer' }).click()
  await expect(page.getByRole('heading', { name: 'Nova', level: 1 })).toBeVisible()
})
