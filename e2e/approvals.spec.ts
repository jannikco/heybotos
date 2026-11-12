// The gate: a worker that wants to reach a server waits for the owner's yes, and carries on once it
// has it. In the demo a `.demo-upload` file in a project makes the worker try `ssh deploy@web1 …`,
// and a stand-in ssh notes every call that really got through.
import { rmSync, writeFileSync } from 'node:fs'
import { conversation, drawer, expect, giveTask, inList, inProject, serverCalls, sidebar, signIn, test, type Locator } from './support.ts'

const marker = inProject('price-notes', '.demo-upload')
const REQUEST = 'Request: Connect to the server web1'

test.beforeEach(() => writeFileSync(marker, ''))
test.afterEach(() => rmSync(marker, { force: true }))

/** The worker has asked, and its turn has ended without the server. */
async function waitsForAnAnswer(panel: Locator): Promise<void> {
  await expect(panel.getByRole('article', { name: REQUEST })).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
}

test('a worker that wants to reach a server waits for a yes in the inbox, then carries on', async ({ page }) => {
  const brief = 'Upload the notes to the web server.'
  const before = serverCalls()
  await signIn(page)
  const panel = await giveTask(page, 'price-notes', brief, 'Claude')
  const task = conversation(page, 'price-notes').getByRole('article', { name: `Task: ${brief}` })

  // It asks: in the drawer, on its card in the conversation, and in the inbox.
  await waitsForAnAnswer(panel)
  await expect(task.getByRole('article', { name: REQUEST })).toBeVisible()
  const more = sidebar(page).getByRole('navigation', { name: 'More' })
  await more.getByRole('link', { name: 'Inbox 1' }).click()
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible()
  const card = page.getByRole('main').getByRole('article', { name: REQUEST })
  await expect(card.getByText('ssh deploy@web1 "cd /var/www/shop && git pull"')).toBeVisible()
  await expect(card.getByRole('link', { name: brief })).toBeVisible()
  expect(serverCalls()).toBe(before) // nothing was connected to

  await card.getByLabel('A note for the worker, if you like').fill('Only pull, do not restart anything.')
  await card.getByRole('button', { name: 'Allow for 15 minutes' }).click()
  await expect(page.getByText('Nothing is waiting for you.')).toBeVisible()
  await expect(more.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible()
  await expect.poll(serverCalls, { timeout: 15_000 }).toBe(before + 1)

  // Back in the conversation the worker has been told, and took a second turn.
  await inList(page, 'price-notes').click()
  await task.getByRole('link', { name: brief }).click()
  await expect(panel.getByText('Allowed for the next 15 minutes: Connect to the server web1 (Only pull, do not restart anything.)')).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Turn 2' })).toHaveAttribute('aria-current', 'page')
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  await expect(task.getByRole('article', { name: REQUEST })).toHaveCount(0)

  await more.getByRole('link', { name: 'Inbox', exact: true }).click()
  await expect(page.getByText('Nothing is waiting for you.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Decided earlier' })).toBeVisible()
  const decided = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Only pull, do not restart anything.' })
  await expect(decided).toContainText('Connect to the server web1')
  await expect(decided).toContainText('Allowed')
})

test('"Always allow this server" on the request lets later workers through without asking', async ({ page }) => {
  const before = serverCalls()
  await signIn(page)
  let panel = await giveTask(page, 'price-notes', 'Upload the notes again.', 'Claude')

  // Answered right on the task's card in the conversation.
  const task = conversation(page, 'price-notes').getByRole('article', { name: 'Task: Upload the notes again.' })
  await waitsForAnAnswer(panel)
  expect(serverCalls()).toBe(before)
  await task.getByRole('article', { name: REQUEST }).getByRole('button', { name: 'Always allow this server' }).click()
  await expect(task.getByRole('article', { name: REQUEST })).toHaveCount(0)
  await expect(panel.getByRole('article', { name: REQUEST })).toHaveCount(0)
  await expect.poll(serverCalls, { timeout: 15_000 }).toBe(before + 1)
  await panel.getByRole('link', { name: 'Turn 2' }).click()
  await expect(panel.getByText('Connect to the server web1 (From now on this server does not need asking.)')).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(task).toContainText('Done')

  // The next worker that wants the same server is not held up.
  panel = await giveTask(page, 'price-notes', 'Upload once more.', 'Claude')
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  await expect(panel.getByRole('article', { name: REQUEST })).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'Turn 2' })).toHaveCount(0)
  expect(serverCalls()).toBe(before + 2)

  // The server is on the list in Settings now; taking it off again makes workers ask as before.
  await sidebar(page).getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Safety' }).click()
  const web1 = page.getByRole('list', { name: 'Servers' }).getByRole('switch', { name: 'Reach web1 without asking' })
  await expect(web1).toBeChecked()
  await web1.click()
  await expect(web1).not.toBeChecked()
  await expect(page.getByRole('status', { name: 'Saving' })).toHaveText('Saved')
  // Switched off, the server stays on the page, so a slip is easy to take back.
  await expect(page.getByRole('list', { name: 'Servers' }).getByText('web1', { exact: true })).toBeVisible()

  panel = await giveTask(page, 'price-notes', 'Upload a last time.', 'Claude')
  await waitsForAnAnswer(panel)
  expect(serverCalls()).toBe(before + 2)
  // This time the answer is no, given on the request in the drawer, with a word on why.
  const request = panel.getByRole('article', { name: REQUEST })
  await request.getByLabel('A note for the worker, if you like').fill('Not from this machine.')
  await request.getByRole('button', { name: "Don't allow" }).click()
  await expect(request).toHaveCount(0)
  // A no reaches the worker too: it takes its second turn without the server.
  await panel.getByRole('link', { name: 'Turn 2' }).click()
  await expect(panel.getByText('Not allowed: Connect to the server web1 (Not from this machine.)')).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Report', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Done', { exact: true })).toBeVisible()
  expect(serverCalls()).toBe(before + 2)
})

// A daemon bug, in apps/daemon/src/approvals.ts: the listener `bus.on('task', …)` in the constructor
// resumes the worker from inside the 'task' event that says its turn has ended. The events about the
// new turn ("waiting", "working", with the new run) are sent from within that one, so everything that
// started listening later, which is every open browser, gets them first and the older "done" last.
// The dashboard then shows the task as done, and its card opens the first turn, for as long as the
// second turn lasts. It only happens when the yes is given while the worker is still busy.
test('a yes given while the worker is still busy shows the task working again when it carries on', async ({ page }) => {
  const brief = 'Upload while the answer comes early.'
  const before = serverCalls()
  await signIn(page)
  const panel = await giveTask(page, 'price-notes', brief, 'Claude')
  const task = conversation(page, 'price-notes').getByRole('article', { name: `Task: ${brief}` })
  await panel.getByRole('article', { name: REQUEST }).getByRole('button', { name: 'Allow for 15 minutes' }).click()
  // Its first turn ends, it hears the yes, and its second turn gets through to the server.
  await expect.poll(serverCalls, { timeout: 15_000 }).toBe(before + 1)
  await expect(task).toContainText('Working')
  await drawer(page).getByRole('link', { name: 'Close details' }).click()
  await task.getByRole('link', { name: brief }).click()
  await expect(panel.getByText('Allowed for the next 15 minutes: Connect to the server web1')).toBeVisible()
  await expect(task).toContainText('Done', { timeout: 20_000 })
})
