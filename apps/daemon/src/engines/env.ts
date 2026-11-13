// The environment a worker CLI gets. Built from an allowlist, never by copying the daemon's own:
// a provider key variable in the environment would silently switch a CLI from the subscription
// login to metered billing, so nothing gets through unless it is named here.
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter } from 'node:path'
import { workerPath } from '../home.ts'
import { userShell, WIN } from '../platform.ts'

const PASS_THROUGH = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', '__CF_USER_TEXT_ENCODING']
/** Linux: where the session keeps its settings and how programs reach the desktop (a browser for a sign-in, the keyring). */
export const PASS_LINUX = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']
/** Windows: programs do not start without knowing where the system and the owner's folders are. */
export const PASS_WINDOWS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']

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
    ...(WIN ? {} : { SHELL: userShell() }),
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    HEYBOTOS_RUN_ID: opts.runId,
  }
  for (const k of [...PASS_THROUGH, ...(WIN ? PASS_WINDOWS : process.platform === 'linux' ? PASS_LINUX : [])]) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return { ...env, ...(opts.extra ?? {}) }
}
