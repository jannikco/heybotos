// Talking to the manager, in the general conversation and in a project's, and the routines it
// carries out by itself.
import { conversation, expect, inList, jumpTo, sidebar, signIn, test, type Locator } from './support.ts'

const ANSWER = 'Fixed. The nav now follows the real header height'
/** What the manager said after a given line in a conversation (a message of the owner's, or a note). */
const saidAfter = (chat: Locator, line: Locator) => line.last().locator('xpath=following-sibling::*').and(chat.getByRole('article', { name: 'Manager said' })).first()

test('talk to the manager: it answers in the conversation, and a project gets a conversation of its own', async ({ page }) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/t\/chief$/)
  const chat = conversation(page, 'Manager')
  const box = chat.getByLabel('Message to the manager')
  await expect(box).toBeFocused()
  await box.fill('How are things in the shop?')
  // Watch the answer while it is being written: the pipes of its table must never show as text.
  await page.evaluate(() => {
    const seen = window as unknown as { pipes: boolean }
    seen.pipes = false
    const look = () => {
      if (document.querySelector('[aria-live] .prose-run')?.textContent?.includes('|')) seen.pipes = true
    }
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await chat.getByRole('button', { name: 'Send' }).click()
  const asked = chat.getByRole('article', { name: 'You said' }).filter({ hasText: 'How are things in the shop?' })
  await expect(asked).toBeVisible()
  await expect(box).toHaveValue('')
  // While it works the turn can be stopped; the answer replaces that.
  await expect(chat.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(saidAfter(chat, asked)).toContainText(ANSWER, { timeout: 20_000 })
  await expect(chat.getByRole('button', { name: 'Stop' })).toBeHidden()

  // The answer is set as text: its table is a table and its list sits inside its list, with none of
  // the marks it was written with left over.
  const answer = saidAfter(chat, asked)
  await expect(answer.getByRole('table')).toBeVisible()
  await expect(answer.getByRole('columnheader', { name: 'What changed' })).toBeVisible()
  await expect(answer.getByRole('row', { name: /menu\.ts.*Reads the header height when the menu opens.*11/ })).toBeVisible()
  await expect(answer.getByRole('listitem').filter({ hasText: 'Look at the shop on a phone' }).getByRole('listitem')).toHaveCount(2)
  await expect(answer).not.toContainText('|')
  await expect(answer).not.toContainText('`')
  expect(await page.evaluate(() => (window as unknown as { pipes: boolean }).pipes), 'pipes showed while the answer was written').toBe(false)

  // On a phone the table scrolls inside its own frame and the page stays where it is.
  const size = page.viewportSize()!
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(answer.getByRole('region', { name: 'Table, scrolls sideways' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.setViewportSize(size)
  await expect(answer.getByRole('region', { name: 'Table, scrolls sideways' })).toHaveCount(0)

  // The conversation is still there after a reload.
  await page.reload()
  await expect(asked).toBeVisible()
  await expect(saidAfter(chat, asked)).toContainText(ANSWER)

  // In a project's conversation the manager answers there, and the list on the left follows along.
  await jumpTo(page, 'price-notes')
  const project = conversation(page, 'price-notes')
  await project.getByLabel('Message to the manager').fill('What is left to do here?')
  await project.getByLabel('Message to the manager').press('Enter')
  const askedThere = project.getByRole('article', { name: 'You said' }).filter({ hasText: 'What is left to do here?' })
  await expect(askedThere).toBeVisible()
  await expect(inList(page, 'price-notes')).toContainText('Manager is answering')
  await expect(saidAfter(project, askedThere)).toContainText(ANSWER, { timeout: 20_000 })
  await expect(inList(page, 'price-notes')).toContainText(ANSWER)
  await expect(inList(page, 'price-notes')).not.toContainText('Manager is answering')

  // What was said in the project stays out of the general conversation.
  await sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: 'Manager, leads the team' }).click()
  await expect(asked).toBeVisible()
  await expect(chat.getByText('What is left to do here?')).toHaveCount(0)

  // The manager's own turns are the conversation, not work on the list of workers.
  await jumpTo(page, 'All work')
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: /How are things in the shop|What is left to do here/ })).toHaveCount(0)
})

test('set up a routine, run it now, switch it off, remove it', async ({ page }) => {
  await signIn(page, '/routines')
  await expect(page.getByText('No routines yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Add a routine' }).click()
  const form = page.getByRole('form', { name: 'New routine' })
  await form.getByLabel('Name', { exact: true }).fill('Morning brief')
  await form.getByLabel('What should the manager do each time?').fill('Tell me what needs my attention today.')
  await form.getByLabel('At', { exact: true }).fill('07:30')
  await form.getByRole('button', { name: 'Add routine' }).click()
  await expect(page.getByRole('heading', { name: 'Morning brief' })).toBeVisible()
  await expect(page.getByText('Weekdays at 07:30')).toBeVisible()
  await expect(page.getByText(/^Next: /)).toBeVisible()

  // Running it reaches the manager as if the owner had just asked.
  await page.getByRole('button', { name: 'Run it now' }).click()
  await expect(page.getByText(/Last ran just now/)).toBeVisible()
  await sidebar(page).getByRole('navigation', { name: 'Your team' }).getByRole('link', { name: 'Manager, leads the team' }).click()
  const chat = conversation(page, 'Manager')
  const due = chat.getByRole('status').filter({ hasText: 'The routine "Morning brief" came due. The manager is on it.' })
  await expect(due).toBeVisible()
  await expect(saidAfter(chat, due)).toContainText(ANSWER, { timeout: 20_000 })
  await expect(chat.getByRole('button', { name: 'Stop' })).toBeHidden()

  // Routines are reached from Settings.
  await sidebar(page).getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('main').getByRole('link', { name: 'Routines' }).click()
  await page.getByRole('button', { name: 'Switch off' }).click()
  await expect(page.getByText('Switched off')).toBeVisible()
  await expect(page.getByText(/^Next: /)).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch on' }).click()
  await expect(page.getByText('Switched off')).toHaveCount(0)
  await expect(page.getByText(/^Next: /)).toBeVisible()
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('No routines yet.')).toBeVisible()
})

test('attach files to a message: picked or pasted, shown before sending, and kept on the message', async ({ page }) => {
  await signIn(page)
  const chat = conversation(page, 'Manager')
  const box = chat.getByLabel('Message to the manager')
  const send = chat.getByRole('button', { name: 'Send' })
  await expect(chat.getByRole('button', { name: 'Attach files' })).toBeVisible()
  await expect(send).toBeDisabled()

  // Two files are picked: they wait in the field, and one can be taken off again.
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await chat.locator('input[type=file]').setInputFiles([
    { name: 'sketch.png', mimeType: 'image/png', buffer: pixel },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Ship on Friday.') },
  ])
  const waiting = chat.locator('form').getByRole('list', { name: 'Attached files' })
  await expect(waiting.getByRole('listitem')).toHaveCount(2)
  await expect(waiting.getByRole('button', { name: 'Open sketch.png' })).toBeVisible()
  await waiting.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(waiting.getByRole('listitem')).toHaveCount(1)

  // A copied file that is pasted into the field is attached too, and the text stays as it was.
  await box.fill('Use these.')
  await box.evaluate((el) => {
    const data = new DataTransfer()
    data.items.add(new File(['Brief'], 'brief.pdf', { type: 'application/pdf' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(waiting.getByRole('link', { name: /Download brief\.pdf/ })).toBeVisible()
  await expect(box).toHaveValue('Use these.')

  // Sent: the field is empty again and the message carries both files, also after a reload.
  await send.click()
  const said = chat.getByRole('article', { name: 'You said' }).filter({ hasText: 'Use these.' })
  await expect(said.getByRole('listitem')).toHaveCount(2)
  await expect(chat.locator('form').getByRole('list', { name: 'Attached files' })).toHaveCount(0)
  await expect(box).toHaveValue('')
  await page.reload()
  await expect(said.getByRole('button', { name: 'Open sketch.png' })).toBeVisible()
  await expect(said.getByRole('link', { name: /Download brief\.pdf/ })).toBeVisible()
  // The picture opens large, and the file itself is what was sent.
  await said.getByRole('button', { name: 'Open sketch.png' }).click()
  await expect(page.getByRole('dialog', { name: 'Picture' })).toBeVisible()
  await page.keyboard.press('Escape')
  const got = await page.request.get(await said.getByRole('link', { name: /Download brief\.pdf/ }).getAttribute('href').then((h) => h!))
  expect(await got.text()).toBe('Brief')

  // Files alone are a message too.
  await chat.locator('input[type=file]').setInputFiles([{ name: 'later.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }])
  await expect(send).toBeEnabled()
  await send.click()
  await expect(chat.getByRole('article', { name: 'You said' }).filter({ has: page.getByRole('link', { name: /Download later\.txt/ }) })).toBeVisible()
})
