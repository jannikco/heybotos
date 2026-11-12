// Giving the team work by hand: from the dialog to the report, with the drawer beside the
// project's conversation showing every step.
import { readFileSync } from 'node:fs'
import { conversation, drawer, expect, giveTask, inList, inProject, jumpTo, newTaskDialog, sidebar, signIn, startTask, test } from './support.ts'

const header = () => readFileSync(inProject('shop', 'resources', 'css', 'header.css'), 'utf8')

test('give a task in a project, watch it work, read the report, undo the changes, send a follow-up', async ({ page }) => {
  const brief = 'Fix the header overlap on phones.'
  await signIn(page)

  // The dialog only takes a project that exists.
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  const dialog = newTaskDialog(page)
  await dialog.getByLabel('Project').fill('no-such-project')
  await dialog.getByLabel('What should it achieve?').fill(brief)
  await dialog.getByLabel('Engine', { exact: true }).selectOption({ label: 'Claude' })
  await dialog.getByRole('button', { name: 'Start task' }).click()
  await expect(dialog.getByRole('alert')).toContainText('There is no project called "no-such-project"')
  await dialog.getByLabel('Project').fill('shop')
  await dialog.getByRole('button', { name: 'Start task' }).click()

  // It lands in the project's conversation, with the task as a card there and open in the drawer.
  await expect(page).toHaveURL(/\/t\/shop\/[^/]+$/)
  const chat = conversation(page, 'shop')
  const card = chat.getByRole('article', { name: `Task: ${brief}` })
  const panel = drawer(page)
  await expect(panel.getByRole('heading', { name: brief })).toBeVisible()
  await expect(panel.getByText('Working', { exact: true })).toBeVisible()
  await expect(card).toContainText('Working')
  await expect(card).toContainText('Ada · Engineer')
  // Who is out there right now also shows above the conversation and in the list on the left.
  await expect(chat.getByText('Ada working')).toBeVisible()
  await expect(inList(page, 'shop')).toContainText('Ada: ')
  await expect(panel.getByRole('link', { name: 'shop' })).toHaveAttribute('href', '/projects/shop')

  // The transcript fills in: a tool call, a nested sub-agent, then the report.
  await expect(panel.getByText('Run the header tests', { exact: true })).toBeVisible()
  await expect(panel.getByText('Find other hard-coded header offsets')).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  await expect(card).toContainText('Done')
  // The list on the left has the project's conversation now, with how the work ended.
  await expect(inList(page, 'shop')).toContainText('The nav no longer slides under the header on narrow screens.')

  // What it really did to the folder, and taking it back.
  const changes = panel.getByRole('region', { name: 'What changed in the folder' })
  await expect(changes.getByText('CHANGES.md')).toBeVisible()
  await expect(changes.getByText('in 2 files')).toBeVisible()
  expect(header()).toContain('var(--header-h)')
  await changes.getByRole('button', { name: 'Show the line-by-line changes' }).click()
  await expect(changes.getByText('+.site-nav { margin-top: var(--header-h); }')).toBeVisible()
  await changes.getByRole('button', { name: 'Undo these changes' }).click()
  await changes.getByRole('alertdialog', { name: 'Confirm undo' }).getByRole('button', { name: 'Undo changes' }).click()
  await expect(changes.getByText('Put 2 files back to how they were before the task.')).toBeVisible()
  await expect(changes.getByText('Nothing in the folder differs from before the task started.')).toBeVisible()
  expect(header()).toContain('margin-top: 64px')

  // A follow-up is a second turn of the same task, not a new one.
  await panel.getByLabel('Send a follow-up to this agent').fill('Now do the footer.')
  await panel.getByRole('button', { name: 'Send' }).click()
  await expect(panel.getByRole('link', { name: 'Turn 2' })).toBeVisible()
  await expect(panel.getByText('Now do the footer.')).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  await expect(chat.getByRole('article', { name: /^Task:/ })).toHaveCount(1)

  // The drawer closes, and the card in the conversation opens it again.
  await panel.getByRole('link', { name: 'Close details' }).click()
  await expect(panel).toBeHidden()
  await expect(page).toHaveURL(/\/t\/shop$/)
  await card.getByRole('link', { name: brief }).click()
  await expect(panel.getByRole('link', { name: 'Turn 2' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('stop a working task', async ({ page }) => {
  await signIn(page)
  await jumpTo(page, 'price-notes')
  const chat = conversation(page, 'price-notes')

  // C opens the dialog whenever the cursor is not in a text field; in a project's conversation it knows the project.
  await chat.getByRole('heading', { name: 'price-notes', level: 1 }).click()
  await page.keyboard.press('c')
  await expect(newTaskDialog(page).getByLabel('Project')).toHaveValue('price-notes')
  const panel = await startTask(page, 'A long job.', { engine: 'Claude' })
  await expect(panel.getByText('Working', { exact: true })).toBeVisible()

  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect(panel.getByText('Stopped', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('You stopped it here.')).toBeVisible()
  await expect(panel.getByText('This folder is not a git repository')).toBeVisible()
  await expect(chat.getByRole('article', { name: 'Task: A long job.' })).toContainText('You stopped it')
})

test('choose the engine and the model for a task, and see it on the usage page and the board', async ({ page }) => {
  await signIn(page)

  // One task for Codex.
  await sidebar(page).getByRole('button', { name: 'New task' }).click()
  let dialog = newTaskDialog(page)
  await expect(dialog.getByLabel('Engine', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('Engine', { exact: true }).getByRole('option', { selected: true })).toHaveText('Automatic: whoever has room')
  await expect(dialog.getByLabel('Model', { exact: true })).toBeDisabled()
  let panel = await startTask(page, 'Read the note and report.', { project: 'shop', engine: 'Codex' })
  await expect(panel.getByText('Codex', { exact: true })).toBeVisible()
  await expect(panel.getByText('cat note.txt', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('Started on the Codex default model, with no connectors.')).toBeVisible()
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()

  // One for Claude, on a model and an effort from the lists. This time from the board, with the C key.
  await jumpTo(page, 'Board')
  await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible()
  await page.keyboard.press('c')
  dialog = newTaskDialog(page)
  await dialog.getByLabel('Engine', { exact: true }).selectOption({ label: 'Claude' })
  const model = dialog.getByLabel('Model', { exact: true })
  const effort = dialog.getByLabel('Effort', { exact: true })
  await expect(model).toBeEnabled()
  // The lists come from the tools themselves, so the test takes whatever is offered second.
  await expect.poll(() => model.getByRole('option').count()).toBeGreaterThan(1)
  await model.selectOption({ index: 1 })
  await effort.selectOption({ index: 1 })
  const picked = { model: await model.inputValue(), effort: await effort.inputValue() }
  expect(picked.model).not.toBe('')
  expect(picked.effort).not.toBe('')
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/tasks')
  panel = await startTask(page, 'Summarise the notes.', { project: 'price-notes' })
  expect((await sent).postDataJSON()).toMatchObject({ project: 'price-notes', engine: 'claude', ...picked })
  await expect(panel.getByText('Claude', { exact: true })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()

  // Each engine's standing, and how the work is spread when nobody names one.
  await jumpTo(page, 'Usage')
  const claude = page.getByRole('region', { name: 'Claude' })
  const codex = page.getByRole('region', { name: 'Codex' })
  await expect(claude.getByText('Taking work')).toBeVisible()
  await expect(claude.getByText(/\b[1-9]\d* turns? today/)).toBeVisible()
  await expect(codex.getByText(/\b[1-9]\d* turns? today/)).toBeVisible()
  await expect(codex.getByText('Codex does not report how much of the plan is used.')).toBeVisible()
  await expect(page.getByText('Automatic: Claude, Codex, Grok share the work')).toBeVisible()

  // The board has both tasks, and can show one project's.
  await jumpTo(page, 'Board')
  const finished = page.getByRole('region', { name: 'Finished' })
  await expect(finished.getByRole('link', { name: /Read the note and report\./ })).toBeVisible()
  await expect(finished.getByRole('link', { name: /Summarise the notes\./ })).toBeVisible()
  await page.getByLabel('Show tasks for').selectOption({ label: 'price-notes' })
  await expect(finished.getByRole('link', { name: /Summarise the notes\./ })).toBeVisible()
  await expect(finished.getByRole('link', { name: /Read the note and report\./ })).toHaveCount(0)

  // A card on the board opens the task among all the work.
  await finished.getByRole('link', { name: /Summarise the notes\./ }).click()
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(drawer(page).getByRole('heading', { name: 'Summarise the notes.' })).toBeVisible()
  await expect(drawer(page).getByRole('heading', { name: 'Report', exact: true })).toBeVisible()
})

// The stand-in for Claude replays a recorded reading of the weekly limit (83% used). The recording
// says that window resets on 12 November 2026 at 06:00 UTC (a fixed time in
// apps/daemon/test/fixtures/make-rich.mjs), and the daemon rightly drops a reading whose window has
// reset, so since then the usage page has nothing to show. To bring this test back, have
// apps/daemon/scripts/demo.ts hand the stand-in a copy of the recording with the reset moved ahead of now.
test('the usage page shows how full the weekly limit is', async ({ page }) => {
  await signIn(page)
  const panel = await giveTask(page, 'price-notes', 'Count the notes.', 'Claude')
  await expect(panel.getByText('Done', { exact: true })).toBeVisible({ timeout: 20_000 })
  await jumpTo(page, 'Usage')
  const claude = page.getByRole('region', { name: 'Claude' })
  await expect(claude.getByRole('meter', { name: 'Weekly limit used' })).toHaveAttribute('aria-valuenow', '83')
  await expect(claude.getByText('83% used')).toBeVisible()
  await expect(claude.getByText('New workers are not started above 95%')).toBeVisible()
})
