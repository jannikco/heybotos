# HeyBotOS

A project-manager agent harness: one manager agent you talk to in a local dashboard, which starts worker
agents and shows everything they do. It runs only on the user's subscriptions by starting the three official
CLIs (`claude`, `codex`, `grok`) as child processes. This file is the guide to the code and its rules, for
coding agents and people alike; `CONTRIBUTING.md` has the short version.

## Hard rules

- **Subscriptions only.** Never call a model API directly, never read a CLI's stored token. Workers get their
  environment from the allowlist in `apps/daemon/src/engines/env.ts`; do not add a pass-through for key
  variables. Every Claude run is checked for the subscription login on its first line and killed otherwise.
- **No provider API hostnames, key-variable names or model names in any file in this repo** (code, tests,
  fixtures, docs, prompts). Model choices live in the user's own `~/heybotos/config/heybotos.json`. A recorded
  fixture is cleaned of names, paths, ids, tool lists and model names before it is committed.
- **Nothing private in the repository.** No real names of people, companies, servers or projects, no home
  paths, no keys. Examples use made-up names (`shop`, `web1`, `example.org`).
- **Three systems, one of them unseen.** The tests run on macOS, Linux and Windows in the GitHub check. In a
  test, never write a Unix path into a shell script or call a program by a fixed path: use `sh()`, `git()`,
  `standIn()` and `scriptEnv()` from `apps/daemon/test/helpers.ts`. Say "this computer", not "this Mac".
- **Tests never spend usage.** `pnpm test` and `pnpm e2e` use the fake CLI in `apps/daemon/test/fakes/` that
  replays recorded fixtures. Only `pnpm smoke` talks to a real CLI; run it deliberately and with a small model
  (`HEYBOTOS_SMOKE_MODEL`).
- **Loopback only.** The daemon binds 127.0.0.1 and every API call passes the Host, Origin and session checks
  in `apps/daemon/src/http/auth.ts`. Three endpoints outside `/api/*` change state, each with its own proof instead of the
  owner's session: `/mcp` (the manager's tool server, the manager's token), `/connect/<pass>` (the connector
  gateway, a pass that is only good while its run is alive) and `/oauth/callback` (the return from a
  connector's sign-in page, a single-use state HeyBotOS handed out).
- **Connector keys stay in the daemon.** HeyBotOS's own connectors (`src/connect/`) keep their headers,
  environment and sign-in tokens in the database (file mode 0600) and nothing sends them out: not the API
  (`ConnectorView` has no such field), not a run's files, not a worker's arguments. A worker gets only the
  gateway address with its run's pass. HeyBotOS signs in to a connector as its own app; it never borrows a login
  one of the CLIs holds.
- **Request bodies are picked field by field.** Per-run internals (`RunExtra`: environment, hooks, connectors)
  are never taken from an HTTP request.
- Ports: daemon 4747, demo 4748, browser tests 4749, dashboard dev server 5175.
- Commit only when the user asks.

## Layout

- `packages/protocol` — shared types, nothing at runtime (the daemon imports it with `import type` only).
- `apps/daemon` — Node 26 running TypeScript directly (type stripping: no enums, no constructor parameter
  properties, `.ts` import extensions). Inside the Mac app the same source runs on Electron's Node, so it must
  also work there: run the daemon tests on that runtime before a release (see `scripts/release.mjs`), and
  start HeyBotOS's own scripts through `nodeCommand()` in `src/home.ts`, never through a bare `process.execPath`.
  Import from `@heybotos/protocol` with `import type` only: the app ships without that package. Hono HTTP + SSE, `node:sqlite` behind `src/db.ts`.
  - `src/engines/supervisor.ts` owns every worker process: prompt on stdin, stdout to
    `~/heybotos/state/runs/<id>/stdout.jsonl`, tailed with a stored offset so a daemon restart loses nothing.
  - `src/engines/claude.ts` and `codex.ts` map each CLI's stream to the shared event vocabulary. Shapes come
    from recorded runs in `test/fixtures/`, not from documentation.
  - `src/tasks.ts` (tasks, baselines, undo, and the tracker: keys like `BOT-12`, stages and moves, fields
    with history, comments, links, search, saved filters), `src/files.ts` (attachments, kept under
    `~/heybotos/files`, never served as something that can run), `src/registry.ts` (projects and their keys),
    `src/git.ts` (snapshots in a temporary index, refs under `refs/heybotos/`).
  - `src/migrate.ts` carries an installation from the old name (BotOS, `~/botos`) over, once.
  - `src/platform.ts` is the one place that knows which system this is: where programs are found and how
    they are started (`launch()`, `startProgram()`, `runProgram()`: on Windows a script or command file
    cannot be started directly), how a worker and everything it started is stopped, notifications, staying
    awake, opening a link. Do not test `process.platform` elsewhere in the service, and do not write a
    fixed path to a program (`/usr/bin/git`): ask `platform.ts`. `src/cli.ts` holds the background service
    for each system (launchd, systemd user service or autostart entry, Windows Run key).
  - `src/updates.ts` finds a newer version (the signed list at `updates/latest.json` in this repository),
    fetches the file for this system and checks it against the list. It never installs: the desktop app
    does (`installUpdate()` in `apps/desktop/main.mjs`, a script per system that swaps the app once it has
    closed). Nothing from an unsigned or badly described list may be used, and no address but an https one.
  - `src/policy/gate.ts` + `src/approvals.ts` + `hooks/` — the gate: rulebook, inbox requests, the
    PreToolUse hook and the PATH wrappers. Workers also get `state/zdot` as their zsh start-up folder so the
    wrappers stay first in login shells.
  - `src/manager.ts` + `src/mcp.ts` — the manager session, its inbox, and its tool server at `/mcp`.
  - `src/router.ts` (engine choice, limits, cooldowns), `src/routines.ts` (schedules).
  - `src/connect/` — HeyBotOS's own connectors. `registry.ts` (set up once, in the database), `client.ts`
    (talks to a connector: a program or a web address), `oauth.ts` (sign-in through the browser),
    `gateway.ts` (the one MCP server at `/connect/<pass>` that workers on every engine talk to; it offers
    the connectors the run's task was given and puts every call through the gate). Workers see it as the
    server `hub`, tools named `<connector>--<tool>` (never a double underscore: Grok drops such tools).
    Claude gets it by `--mcp-config`, Codex by `-c mcp_servers.hub.*`, Grok by a per-run `--agent` file.
- `apps/web` — Vue 3.5 + Vite + Tailwind 4. Tokens in `src/style.css`. Uses TypeScript 6 because `vue-tsc`
  does not run on 7 yet.
  - Agent text is shown with `components/Prose.vue` (`<Prose :text />`, `live` while it is being written),
    which renders Markdown through `src/markdown.ts` (markdown-it with raw HTML and images off, web links
    only). Never put agent text in `v-html` any other way. Its unit tests are in `apps/web/test/`.
  - Settings (`views/SettingsView.vue`, `/settings/:section?`) is a rail of sections, each a pane in
    `views/settings/`. There are no Save buttons: a control calls `change(key, patch)` from `src/settings.ts`,
    which saves that one thing and shows a refusal beside it. Build new settings from the kit in
    `components/ui/` (`SettingGroup`, `SettingRow`, `UiSwitch`, `UiSegmented`, `UiStepper`, `UiList`), not
    from bare checkboxes and text boxes.
  - Agent text and the brand: `components/brand/` holds the HeyBotOS mark and wordmark as path data
    (`paths.ts`, from the logo package); `BrandMark` is also the manager's face. Colours are tokens in
    `src/style.css`: the logo's navy as ground, its blue as the accent, the gradient only for the logo and the
    main action. Status colours keep their meaning.
  - The tracker's pages are not built yet. Its service side is: `src/tracker.ts` and `components/task/` are
    the start of the pages.
- `apps/desktop` — the desktop app, an Electron shell, for macOS, Linux and Windows. `scripts/make-app.mjs` builds `HeyBotOS.app` with the
  service, the dashboard, the prompts and the gate scripts under `Contents/Resources/heybotos`, laid out as in
  this repository, and run by the app's own runtime (`ELECTRON_RUN_AS_NODE`). Every time the app opens it
  calls `cli.ts ensure`, which sets up, starts or (after an update) restarts the background service
  `com.heybotos.daemon`. `scripts/release.mjs` builds both architectures, signs, zips and writes the cask;
  `scripts/make-icons.mjs` draws every icon from the mark.
  `scripts/make-linux.mjs` (on Linux: `.deb`, AppImage, `.tar.gz`) and `scripts/make-win.mjs` (on Windows:
  installer and `.zip`) build the other two from the same payload (`scripts/payload.mjs`).
  `scripts/smoke-app.mjs` starts a built app and checks that its window opens and its service answers; the
  GitHub check runs it on Linux and Windows, because that is the only place Windows is ever tried.
  `.github/workflows/release.yml` (run by hand with a tag) adds the Linux and Windows packages to a release.
  `scripts/smoke-update.mjs` has an installed app update itself to a second build (made with `--as`); the
  check runs that too. A release is one command, `pnpm release <patch|minor|version>` (`scripts/release.mjs`
  at the top of the repository): it does all of the above and signs `updates/latest.json` with a key that is
  not in the repository. Never commit a key, and never edit `updates/latest.json` by hand.
- `e2e` — Playwright against the daemon in demo mode.

## Commands

`pnpm release patch` (publish a version, see CONTRIBUTING.md) · `pnpm start` (build dashboard, run daemon) · `pnpm heybotos open` (single-use sign-in link) · `pnpm heybotos
install|uninstall|logs` (background service, label `com.heybotos.daemon`) · `pnpm demo` (fake CLI, throwaway
data) · `pnpm test` · `pnpm e2e` · `pnpm typecheck` · `pnpm smoke` (`HEYBOTOS_SMOKE_ONLY=basic|gate|codex|manager`, or `connect` with `HEYBOTOS_SMOKE_ENGINE=claude|codex|grok`).

Tests that change a fake worker's behaviour between runs must wait until the earlier worker has produced
output (`run.status === 'running'`), not just until its task says running: the stand-in reads its settings
when the process starts.

## Interface writing

Plain words from the user's side: "worker", "needs you", "cut off". Sentence case, no all-caps labels, errors
say what happened and what to do. Status colours carry meaning only: blue working, amber needs you, green
done, red failed.
