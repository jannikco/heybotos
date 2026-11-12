import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { describeSchedule, nextAfter, parseCron } from '../src/routines.ts'
import { FIXTURES, makeWorld, until, type World } from './helpers.ts'

const at = (s: string) => new Date(s).getTime() // local time, like the schedules
const next = (expr: string, from: string) => new Date(nextAfter(parseCron(expr), at(from))).toString().slice(0, 21)

describe('schedules', () => {
  it('finds the next time a schedule comes due', () => {
    // 11 November 2026 is a Wednesday.
    expect(next('30 7 * * *', '2026-11-11T06:00')).toBe('Wed Nov 11 2026 07:30')
    expect(next('30 7 * * *', '2026-11-11T07:30')).toBe('Thu Nov 12 2026 07:30') // strictly after
    expect(next('30 7 * * 1-5', '2026-11-13T08:00')).toBe('Mon Nov 16 2026 07:30') // Friday evening -> Monday
    expect(next('0 9 * * 1', '2026-11-11T10:00')).toBe('Mon Nov 16 2026 09:00')
    expect(next('0 9 * * 7', '2026-11-11T10:00')).toBe('Sun Nov 15 2026 09:00') // 7 is Sunday too
    expect(next('*/15 * * * *', '2026-11-11T10:07')).toBe('Wed Nov 11 2026 10:15')
    expect(next('0 0 1 * *', '2026-11-11T10:00')).toBe('Tue Dec 01 2026 00:00')
    expect(next('0 8 29 2 *', '2026-11-11T10:00')).toBe('Tue Feb 29 2028 08:00') // the next leap day
    expect(next('0 12 1 * 5', '2026-11-11T10:00')).toBe('Fri Nov 13 2026 12:00') // day-of-month OR weekday
    expect(next('0,30 8-9 * * *', '2026-11-11T08:31')).toBe('Wed Nov 11 2026 09:00')
  })

  it('explains what is wrong with a schedule in plain words', () => {
    expect(() => parseCron('7:30 every day')).toThrow(/five parts/)
    expect(() => parseCron('61 7 * * *')).toThrow(/minute must be between 0 and 59/)
    expect(() => parseCron('0 7 * * mon')).toThrow(/day of the week part "mon"/)
    expect(() => parseCron('0 7 31 2 *') && nextAfter(parseCron('0 7 31 2 *'), Date.now())).toThrow(/never comes due/)
  })

  it('says common schedules in words', () => {
    expect(describeSchedule('30 7 * * *')).toBe('Every day at 07:30')
    expect(describeSchedule('30 7 * * 1-5')).toBe('Weekdays at 07:30')
    expect(describeSchedule('0 9 * * 1')).toBe('Mondays at 09:00')
    expect(describeSchedule('0 * * * *')).toBe('Every hour, on the hour')
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes')
    expect(describeSchedule('0 8 1 * *')).toBe('On day 1 of every month at 08:00')
    expect(describeSchedule('5 4 * 3 2,4')).toBe('On the schedule 5 4 * 3 2,4')
  })
})

describe('routines', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
    w.home.config.engines.claude.env = { FAKE_FIXTURE: join(FIXTURES, 'claude-rich.jsonl') }
    w.sup.start()
  })
  afterEach(() => w.cleanup())

  it('fires when due, hands the manager its instructions, and schedules the next time', async () => {
    const t0 = at('2026-11-11T06:00')
    const r = w.routines.create({ title: 'Morning brief', schedule: '30 7 * * 1-5', prompt: 'Summarise what the workers did yesterday.' }, 'user', t0)
    expect(r).toMatchObject({ when: 'Weekdays at 07:30', enabled: true, nextAt: at('2026-11-11T07:30') })
    expect(w.routines.tick(at('2026-11-11T07:29'))).toBe(0)
    expect(w.routines.tick(at('2026-11-11T07:30'))).toBe(1)

    await until(() => w.sup.list().some((x) => x.role === 'manager' && x.status === 'done'))
    const turn = w.sup.list().find((x) => x.role === 'manager')!
    expect(turn.prompt).toContain('[A routine the owner set up has come due: Morning brief]\nSummarise what the workers did yesterday.')
    expect(turn.prompt).not.toContain('[No message from the owner')
    expect(w.manager.state().messages[0]).toMatchObject({ role: 'note', text: 'The routine "Morning brief" came due. The manager is on it.' })
    expect(w.routines.list()[0]).toMatchObject({ lastFiredAt: at('2026-11-11T07:30'), nextAt: at('2026-11-12T07:30') })
  })

  it('fires once after a long sleep, not once per missed day, and starts overdue routines one at a time', () => {
    const t0 = at('2026-11-02T06:00')
    w.routines.create({ title: 'A', schedule: '0 7 * * *', prompt: 'Do A.' }, 'user', t0)
    w.routines.create({ title: 'B', schedule: '0 8 * * *', prompt: 'Do B.' }, 'user', t0)
    const wake = at('2026-11-11T10:00') // nine days later
    expect(w.routines.tick(wake)).toBe(1)
    expect(w.routines.tick(wake + 20_000)).toBe(1)
    expect(w.routines.tick(wake + 40_000)).toBe(0)
    const notes = w.manager.state().messages.filter((m) => m.role === 'note').map((m) => m.text)
    expect(notes).toEqual(['The routine "A" came due. The manager is on it.', 'The routine "B" came due. The manager is on it.'])
    expect(w.routines.list().map((r) => r.nextAt)).toEqual([at('2026-11-12T07:00'), at('2026-11-12T08:00')])
  })

  it('can be switched off and on, run right now, and removed', () => {
    const t0 = at('2026-11-11T06:00')
    const r = w.routines.create({ title: 'Nightly check', schedule: '0 2 * * *', prompt: 'Check the logs.' }, 'user', t0)
    expect(w.routines.setEnabled(r.id, false).nextAt).toBeNull()
    expect(w.routines.tick(at('2026-11-13T03:00'))).toBe(0) // off: nothing fires
    expect(w.routines.setEnabled(r.id, true, at('2026-11-13T03:00')).nextAt).toBe(at('2026-11-14T02:00')) // no catching up
    const ran = w.routines.runNow(r.id, at('2026-11-13T12:00'))
    expect(ran).toMatchObject({ lastFiredAt: at('2026-11-13T12:00'), nextAt: at('2026-11-14T02:00') })
    w.routines.remove(r.id)
    expect(w.routines.list()).toEqual([])
    expect(() => w.routines.remove(r.id)).toThrow(/No routine with id/)
    expect(() => w.routines.create({ title: '', schedule: '0 2 * * *', prompt: 'x' })).toThrow(/Give the routine a name/)
    expect(() => w.routines.create({ title: 'x', schedule: 'daily', prompt: 'x' })).toThrow(/five parts/)
  })
})
