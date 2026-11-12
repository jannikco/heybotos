import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES, makeWorld, until, variant, type World } from './helpers.ts'

let w: World
const RICH = join(FIXTURES, 'claude-rich.jsonl')
const systemOf = (taskId: string) => readFileSync(join(w.home.runs, w.tasks.get(taskId)!.lastRunId!, 'system.md'), 'utf8')

beforeEach(async () => {
  w = makeWorld()
  mkdirSync(join(w.root, 'code', 'shop'))
  await w.registry.scan()
  w.home.config.engines.claude.env = { FAKE_FIXTURE: RICH }
  w.sup.start()
})
afterEach(() => w.cleanup())

describe('the team', () => {
  it('starts with a manager and five specialists, each taking a kind of work', () => {
    const team = w.staff.list()
    expect(team.map((m) => [m.name, m.title, m.isChief])).toEqual([
      ['Manager', 'Leads the team', true],
      ['Ada', 'Engineer', false],
      ['Rex', 'Reviewer', false],
      ['Iris', 'Researcher', false],
      ['Wren', 'Writer', false],
      ['Otto', 'Operator', false],
    ])
    expect(w.staff.forKind('review')!.name).toBe('Rex')
    expect(w.staff.forKind('other')!.name).toBe('Ada')
  })

  it('gives each task to the member who takes that kind of work, unless one is named', async () => {
    const review = w.tasks.create({ project: 'shop', brief: 'Review the change.', kind: 'review' })
    const named = w.tasks.create({ project: 'shop', brief: 'Research with Wren.', kind: 'research', assignee: 'wren' })
    expect([review.assigneeName, named.assigneeName]).toEqual(['Rex', 'Wren'])
    expect(() => w.tasks.create({ project: 'shop', brief: 'x', assignee: 'Nobody' })).toThrow(/Nobody on the team is called "Nobody"/)
    await until(() => w.tasks.get(named.id)!.status === 'done' && w.tasks.get(review.id)!.status === 'done')
    expect(w.tasks.runs(review.id)[0]!.role).toBe('rex')
    expect(w.staff.get('rex')!.stats).toMatchObject({ done: 1, open: 0 })
  })

  it('tells a member who they are, how they work, and what they noted before', async () => {
    w.staff.save({ id: 'ada', persona: 'You always write the failing test first.', memory: '- 2026-11-01 (shop): the header tests need the dev server running.' })
    const t = w.tasks.create({ project: 'shop', brief: 'Fix the header.', kind: 'build' })
    await until(() => w.tasks.get(t.id)!.status === 'done')
    const system = systemOf(t.id)
    expect(system).toMatch(/^You are Ada, the team's Engineer\. Manager leads the team/)
    expect(system).toContain('You always write the failing test first.')
    expect(system).toContain('Your own notes from earlier tasks (newest last):\n- 2026-11-01 (shop): the header tests need the dev server running.')
    expect(system).toContain('You are a worker agent started by HeyBotOS')
  })

  it("keeps a member's note to self and hands it back on the next task", async () => {
    w.home.config.engines.claude.env = {
      FAKE_FIXTURE: variant(w.root, 'noted', (lines) => lines.map((l) => (l.type === 'result' ? { ...l, structured_output: { ...l.structured_output, note_to_self: 'This repo formats on commit; do not run the formatter by hand.' } } : l)), RICH),
    }
    const first = w.tasks.create({ project: 'shop', brief: 'One.', kind: 'build' })
    await until(() => w.tasks.get(first.id)!.status === 'done')
    expect(w.staff.get('ada')!.memory).toMatch(/^- \d{4}-\d\d-\d\d \(shop\): This repo formats on commit; do not run the formatter by hand\.$/)
    const second = w.tasks.create({ project: 'shop', brief: 'Two.', kind: 'build' })
    await until(() => w.tasks.get(second.id)!.status === 'done')
    expect(systemOf(second.id)).toContain('This repo formats on commit')
    expect(w.staff.get('rex')!.memory).toBe('') // each member has their own
  })

  it('lets the owner reshape the team: rename, change role and engine, add, retire', async () => {
    expect(w.staff.save({ id: 'rex', name: 'Sigrid', engine: 'codex' })).toMatchObject({ id: 'rex', name: 'Sigrid', engine: 'codex' })
    const review = w.tasks.create({ project: 'shop', brief: 'Review.', kind: 'review' })
    expect(review).toMatchObject({ assigneeName: 'Sigrid', engine: 'codex' })

    const designer = w.staff.save({ name: 'Mads', title: 'Designer', focus: ['write', 'nonsense'], persona: 'You care about spacing.' })
    expect(designer).toMatchObject({ id: 'mads', focus: ['write'], active: true, engine: 'auto' })
    expect(() => w.staff.save({ name: 'mads', title: 'Other' })).toThrow(/already a team member called "mads"/)
    expect(() => w.staff.save({ name: 'X', title: ' ' })).toThrow(/needs a role/)

    w.staff.save({ id: 'wren', active: false })
    expect(w.staff.forKind('write')!.name).toBe('Mads') // the retired writer gets no new work
    expect(() => w.tasks.create({ project: 'shop', brief: 'x', assignee: 'Wren' })).toThrow(/not on the active team/)
    expect(w.staff.get('wren')!.active).toBe(false)

    expect(w.staff.save({ id: 'chief', name: 'Chief of Staff' }).name).toBe('Chief of Staff')
    expect(w.manager.name()).toBe('Chief of Staff')
    await until(() => w.tasks.get(review.id)!.status === 'done')
  })

  it('keeps memory bounded: the oldest notes fall away', () => {
    for (let i = 0; i < 40; i++) w.staff.remember('ada', `Note number ${i} ${'x'.repeat(300)}`, 'shop')
    const memory = w.staff.get('ada')!.memory
    expect(memory.length).toBeLessThanOrEqual(6000)
    expect(memory).toContain('Note number 39')
    expect(memory).not.toContain('Note number 0 ')
  })
})
