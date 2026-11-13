# Contributing to HeyBotOS

Thank you for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first and say what you have in mind. It saves you from
  building something that does not fit.
- Security problems do not go in public issues: see [SECURITY.md](SECURITY.md).

## Setting up

You need macOS or Linux, Node 26 and pnpm. (Windows works too for the tests; the background service there comes only with the built app.)

```sh
pnpm install
pnpm demo        # the real service on throwaway data, with a stand-in for the CLIs; http://127.0.0.1:4748
pnpm test        # unit tests
pnpm e2e         # browser tests (needs Google Chrome)
pnpm typecheck
```

The demo and all tests use a stand-in CLI that replays recorded runs, so working on HeyBotOS spends none of
your subscription. Only `pnpm smoke` talks to a real CLI; run it deliberately.

## How the code is laid out

| Folder | What it is |
|---|---|
| `packages/protocol` | The types the service and the dashboard share. Types only, nothing at runtime. |
| `apps/daemon` | The service: Node running TypeScript directly, a small HTTP API, SQLite. It owns every worker process. |
| `apps/web` | The dashboard: Vue 3, Vite, Tailwind 4. |
| `apps/desktop` | The desktop app for macOS, Linux and Windows: an Electron shell that carries the service and the dashboard. |
| `prompts` | What the manager and the workers are told. |
| `e2e` | Browser tests against the demo. |

[CLAUDE.md](CLAUDE.md) is the detailed guide to the code and its rules. It is written for coding agents and
reads just as well for people.

## Rules that are not up for discussion

- **Subscriptions only.** HeyBotOS starts the official CLIs and nothing else. It never calls a model API and
  never reads a token a CLI has stored. Pull requests that add either will be declined.
- **No provider API hostnames, key-variable names or model names in the repository.** Not in code, tests,
  fixtures, docs or prompts. Model choices belong in the user's own config.
- **Tests never spend usage.** New behaviour is tested against the stand-in CLI.
- **Loopback only.** The service binds 127.0.0.1 and every request passes the checks in
  `apps/daemon/src/http/auth.ts`.
- **Nothing private in fixtures.** A recorded run must be cleaned of names, paths, tool lists and ids before
  it is committed.

## Pull requests

- Keep one change per pull request, with tests for what it changes.
- `pnpm typecheck`, `pnpm test` and `pnpm e2e` must pass.
- Write interface text in plain words from the user's side, in sentence case. Colours carry meaning only:
  blue working, amber needs you, green done, red failed.
- By contributing you agree that your contribution is licensed under the MIT licence of this project.
