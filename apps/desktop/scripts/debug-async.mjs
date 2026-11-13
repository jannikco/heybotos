// Temporary: finds out why starting git without waiting for it is slow on the app's runtime on Windows.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hb-debug-'))
execFileSync('git', ['-C', dir, 'init', '-q'])
console.log('runtime', process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, 'git', execFileSync('git', ['--version'], { encoding: 'utf8' }).trim())
const timed = (name, fn) =>
  new Promise((done) => {
    const t = Date.now()
    fn((note) => {
      console.log(`${String(Date.now() - t).padStart(6)} ms  ${name}  ${note ?? ''}`)
      done()
    })
  })
const viaExec = (args, opts) => (done) => execFile('git', args, { timeout: 8000, ...opts }, (err, out) => done(err ? `ERR ${err.killed ? 'killed' : err.code} ${String(err.message).slice(0, 60)}` : JSON.stringify(out.trim().slice(0, 40))))
await timed('execFile --version', viaExec(['--version'], {}))
await timed('execFile --version windowsHide', viaExec(['--version'], { windowsHide: true }))
await timed('execFile rev-parse', viaExec(['-C', dir, 'rev-parse', '--git-common-dir'], {}))
await timed('execFile rev-parse +env', viaExec(['-C', dir, 'rev-parse', '--git-common-dir'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }))
await timed('execFile status', viaExec(['-C', dir, 'status', '--porcelain'], {}))
await timed('spawn stdin ignored', (done) => {
  const c = spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let marks = ''
  const t = Date.now()
  c.on('exit', () => (marks += ` exit@${Date.now() - t}`))
  c.on('close', () => done(`${marks} close@${Date.now() - t}`))
  setTimeout(() => c.kill(), 8000)
})
await timed('spawn stdin piped, ended', (done) => {
  const c = spawn('git', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] })
  c.stdin.end()
  let marks = ''
  const t = Date.now()
  c.on('exit', () => (marks += ` exit@${Date.now() - t}`))
  c.on('close', () => done(`${marks} close@${Date.now() - t}`))
  setTimeout(() => c.kill(), 8000)
})
await timed('six at once', (done) => {
  let left = 6
  for (let i = 0; i < 6; i++) execFile('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { timeout: 8000 }, () => --left || done())
})
console.log('sync for comparison:', (() => { const t = Date.now(); execFileSync('git', ['-C', dir, 'status', '--porcelain']); return Date.now() - t })(), 'ms')
process.exit(0)
