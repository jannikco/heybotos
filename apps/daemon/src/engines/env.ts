// The environment a worker CLI gets. Built from an allowlist, never by copying the daemon's own:
// a provider key variable in the environment would silently switch a CLI from the subscription
// login to metered billing, so nothing gets through unless it is named here.
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter } from 'node:path'
import { workerPath } from '../home.ts'

const PASS_THROUGH = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', '__CF_USER_TEXT_ENCODING']

export interface ChildEnvOptions {
  runId: string
  /** Directories put in front of PATH (the ssh/scp/rsync gate shims). */
  pathPrefix?: string[]
  extra?: Record<string, string>
}

export function childEnv(opts: ChildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...(opts.pathPrefix ?? []), workerPath()].join(delimiter),
    HOME: homedir(),
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    SHELL: '/bin/zsh',
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    HEYBOTOS_RUN_ID: opts.runId,
  }
  for (const k of PASS_THROUGH) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return { ...env, ...(opts.extra ?? {}) }
}
