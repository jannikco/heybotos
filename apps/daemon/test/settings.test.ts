import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeWorld, type World } from './helpers.ts'

let w: World
beforeEach(() => {
  w = makeWorld()
})
afterEach(() => w.cleanup())

const file = (name: string) => JSON.parse(readFileSync(join(w.home.configDir, name), 'utf8'))

describe('settings', () => {
  it('reads everything in one object', () => {
    const s = w.settings.read()
    expect(s.general).toMatchObject({ maxWorkers: 3 })
    expect(s.manager.name).toBe('Manager')
    expect(s.gate.allowedHosts).toContain('github.com')
    expect(s.connectors).toEqual(['memory', 'shopsystem'])
    expect(s.paths.config).toBe(w.home.configDir)
  })

  it('applies a change to the running daemon and to the files', () => {
    const s = w.settings.apply({
      general: { maxWorkers: 5 },
      manager: { name: 'Chief of Staff', effort: 'medium' },
      routing: { byKind: { review: 'claude' } as never, fallback: false, headroom: { claude: 0.8 } as never },
      gate: { allowedHosts: ['GitHub.com', 'buildbox', '*.internal.test', 'buildbox'], hostGrantMinutes: 30, alwaysAllowTools: ['memory/*'] },
      engines: { codex: { effort: 'high' } } as never,
    })
    expect(s.general.maxWorkers).toBe(5)
    expect(w.home.config.maxWorkers).toBe(5)
    expect(w.manager.name()).toBe('Chief of Staff')
    expect(w.router.cfg).toMatchObject({ fallback: false, byKind: { review: 'claude', build: 'claude' }, headroom: { claude: 0.8, codex: 1 } })
    expect(w.approvals.cfg.allowedHosts).toEqual(['github.com', 'buildbox', '*.internal.test'])
    expect(file('heybotos.json')).toMatchObject({ maxWorkers: 5, manager: { effort: 'medium' }, engines: { codex: { effort: 'high' } } })
    expect(file('routing.json').fallback).toBe(false)
    expect(file('gate.json')).toMatchObject({ hostGrantMinutes: 30, alwaysAllowTools: ['memory/*'] })
    // the gate uses the new list at once
    expect(w.approvals.cfg.hostGrantMinutes).toBe(30)
  })

  it('accepts the list it ships with, IPv6 loopback included', () => {
    const hosts = w.settings.read().gate.allowedHosts
    expect(hosts).toContain('::1')
    expect(w.settings.apply({ gate: { allowedHosts: hosts } }).gate.allowedHosts).toEqual(hosts)
  })

  it('refuses a value that makes no sense, and then changes nothing at all', () => {
    const before = JSON.stringify(w.settings.read())
    expect(() => w.settings.apply({ general: { maxWorkers: 0 } })).toThrow(/whole number from 1 to 12/)
    expect(() => w.settings.apply({ general: { maxWorkers: 4 }, gate: { allowedHosts: ['not a host!'] } })).toThrow(/does not look like a server name/)
    expect(() => w.settings.apply({ routing: { byKind: { build: 'gemini' } as never } })).toThrow(/not an engine/)
    expect(() => w.settings.apply({ gate: { alwaysAllowTools: ['send_email'] } })).toThrow(/connector\/tool/)
    expect(() => w.settings.apply({ gate: { askCommandPatterns: ['('] } })).toThrow(/not a valid pattern/)
    expect(() => w.settings.apply({ general: { projectRoots: ['GitHub'] } })).toThrow(/not a full folder path/)
    expect(() => w.settings.apply({ manager: { model: 'x; rm -rf /' } })).toThrow(/can only contain/)
    expect(JSON.stringify(w.settings.read())).toBe(before)
  })
})
