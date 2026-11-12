// `pnpm demo`: the real daemon on a throwaway data folder, with the fake CLI standing in for both
// engines and two small sample projects. For working on the dashboard and for browser tests;
// spends no subscription usage.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.env.HEYBOTOS_HOME || mkdtempSync(join(tmpdir(), 'heybotos-demo-'))
if (process.env.HEYBOTOS_DEMO_FRESH && process.env.HEYBOTOS_HOME) rmSync(root, { recursive: true, force: true })
const code = join(root, 'code')
const fake = join(here, '..', 'test', 'fakes', 'fake-cli.mjs')
mkdirSync(join(root, 'config'), { recursive: true })

const git = (dir: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { stdio: 'ignore' })
if (!existsSync(code)) {
  const shop = join(code, 'shop')
  mkdirSync(join(shop, 'resources', 'css'), { recursive: true })
  writeFileSync(join(shop, 'README.md'), '# Shop\n\nThe web shop for printed things: catalogue, basket and checkout.\n')
  writeFileSync(join(shop, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { vue: '^3.5.0' } }, null, 2))
  writeFileSync(join(shop, 'resources', 'css', 'header.css'), '.site-header { position: fixed; height: 96px; }\n.site-nav { margin-top: 64px; }\n')
  git(shop, 'init', '-q', '-b', 'main')
  git(shop, '-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', 'add', '-A')
  git(shop, '-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'First version')
  mkdirSync(join(code, 'price-notes'), { recursive: true })
  writeFileSync(join(code, 'price-notes', 'README.md'), 'Loose notes on paper prices and supplier quotes.\n')
}

// A worker that really changes the folder before replaying its recorded stream, so the dashboard has
// something to show under "Changes in the folder".
const worker = join(root, 'demo-worker.sh')
writeFileSync(
  worker,
  `#!/bin/sh
if [ -f .demo-upload ] && [ "$1" = "-p" ]; then
  ssh deploy@web1 "cd /var/www/shop && git pull" 2>/dev/null
fi
if [ -f resources/css/header.css ] && [ "$1" = "-p" ]; then
  printf '.site-header { position: fixed; height: 96px; }\\n.site-nav { margin-top: var(--header-h); }\\n' > resources/css/header.css
  printf 'Header height now comes from --header-h.\\n' > CHANGES.md
fi
exec ${JSON.stringify(fake)} "$@"
`,
  { mode: 0o755 },
)

// The recording carries a usage reading with the moment its limit resets. That moment has to lie
// ahead, or the reading counts as out of date and the usage page has nothing to show.
const rich = join(root, 'config', 'demo-claude.jsonl')
// The demo's answer also ends in a table and a list inside a list, so the page has every kind of
// text an agent writes to show. Only this copy gets them; the recording the tests replay stays as it is.
const MORE = [
  '',
  '',
  '| File | What changed | Lines |',
  '|---|---|--:|',
  '| `header.css` | The nav margin follows `--header-h` instead of a fixed 64px, so a taller header no longer covers the first row of the page | 4 |',
  '| `menu.ts` | Reads the header height when the menu opens | 11 |',
  '| `header.test.ts` | Covers a 96px header | 23 |',
  '',
  'Left to do:',
  '',
  '1. Look at the shop on a phone',
  '   - the menu button',
  '   - the sticky basket',
  '2. Deploy when you say so',
].join('\n')
const LAST_LINE = '- `menu.ts` reads the height at runtime'
const CLOSING = 'and the header tests pass.'
const more = JSON.stringify(MORE).slice(1, -1)
const recorded = readFileSync(join(here, '..', 'test', 'fixtures', 'claude-rich.jsonl'), 'utf8')
  .replace(/"resetsAt":\d+/g, `"resetsAt":${Math.floor(Date.now() / 1000) + 3 * 86_400}`)
  .split('\n')
// The addition is written out piece by piece like the rest of the answer, then stands in the finished
// message and in the result the manager's reply is taken from.
const at = recorded.findIndex((l) => l.includes(`${LAST_LINE}"`))
const piece = JSON.parse(recorded[at - 1]!) as { event: { delta: { text: string } } }
const pieces = (MORE.match(/[^]{1,14}/g) ?? []).map((text) => JSON.stringify({ ...piece, event: { ...piece.event, delta: { ...piece.event.delta, text } } }))
recorded[at] = recorded[at]!.replace(`${LAST_LINE}"`, `${LAST_LINE}${more}"`)
recorded.splice(at, 0, ...pieces)
writeFileSync(rich, recorded.map((l) => (l.includes('"type":"result"') ? l.replace(`${CLOSING}"`, `${CLOSING}${more}"`) : l)).join('\n'))
writeFileSync(
  join(root, 'config', 'demo-connectors.json'),
  JSON.stringify({ mcpServers: { shop: { command: process.execPath, args: [join(here, '..', 'test', 'fakes', 'fake-connector.mjs')] }, crm: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } }),
)
writeFileSync(
  join(root, 'config', 'heybotos.json'),
  JSON.stringify(
    {
      port: Number(process.env.HEYBOTOS_DEMO_PORT ?? 4748),
      maxWorkers: 2,
      keepAwake: false,
      welcome: false,
      projectRoots: [code],
      // The demo starts from a stand-in file, so it never copies the owner's real connectors or their keys.
      connectorsFile: join(root, 'config', 'demo-connectors.json'),
      engines: {
        grok: { bin: fake, env: { FAKE_FIXTURE: join(here, '..', 'test', 'fixtures', 'grok-basic.jsonl'), FAKE_DELAY_MS: String(Math.round(Number(process.env.HEYBOTOS_DEMO_DELAY ?? '120') / 4)) } },
        codex: { bin: fake, env: { FAKE_FIXTURE: join(here, '..', 'test', 'fixtures', 'codex-basic.jsonl'), FAKE_DELAY_MS: process.env.HEYBOTOS_DEMO_DELAY ?? '120' } },
        claude: {
          bin: worker,
          env: { FAKE_FIXTURE: rich, FAKE_DELAY_MS: process.env.HEYBOTOS_DEMO_DELAY ?? '120' },
        },
      },
    },
    null,
    2,
  ),
)
// No demo worker ever reaches a real server: a stand-in ssh sits in front of the real one and only
// notes that it was called.
const bin = join(root, 'bin')
mkdirSync(bin, { recursive: true })
writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, 'ssh-calls.txt'))}\n`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`

process.env.HEYBOTOS_HOME = root
console.log(`Demo data folder: ${root}`)
await import('../src/main.ts')
