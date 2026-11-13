// Temporary: finds out which step of a test's set-up is slow on the app's runtime on Windows.
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, makeWorld } from '../../daemon/test/helpers.ts'

console.log('runtime', process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`)
let t = Date.now()
const lap = (what) => {
  console.log(`${String(Date.now() - t).padStart(6)} ms  ${what}`)
  t = Date.now()
}
const w = makeWorld()
lap('makeWorld')
const dir = join(w.root, 'code', 'shop')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
git(dir, 'config', 'user.email', 'test@localhost')
git(dir, 'config', 'user.name', 'Test')
writeFileSync(join(dir, 'README.md'), '# shop\n')
git(dir, 'add', '-A')
lap('init, config, add')
git(dir, 'commit', '-q', '-m', 'first')
lap('commit')
const out = (args, timeout = 10_000) =>
  new Promise((done) => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => done(err ? `ERR ${err.killed ? 'killed' : err.code}` : stdout.trim()))
  })
console.log('   ', await out(['rev-parse', '--git-common-dir']))
lap('rev-parse (not waited for)')
console.log('   ', await out(['log', '-1', '--format=%ct']))
lap('log')
console.log('   ', JSON.stringify(await out(['status', '--porcelain', '--untracked-files=normal'], 20_000)))
lap('status')
await w.registry.scan()
lap('registry.scan')
w.sup.start()
lap('supervisor start')
w.cleanup()
lap('cleanup')
process.exit(0)
