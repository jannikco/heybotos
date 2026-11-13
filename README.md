<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="HeyBotOS" width="460">
  </picture>
</p>

<p align="center"><strong>One manager you talk to. A team of agents that does the work.</strong></p>

> [!WARNING]
> **HeyBotOS is in beta.** It works and is used every day, but expect rough edges and changes between
> versions. Its workers edit files and run commands on your computer without asking first: start with projects
> that are in git, where every change can be seen and undone, and keep backups of anything you care about.

HeyBotOS is a desktop app for macOS, Linux and Windows that runs a team of coding agents for you. You tell the manager what you want done, in
any of your projects. It splits the work into tasks, hands them to workers, keeps track, and comes back with
the result. You see every agent and every step, and you can undo what a worker changed.

It runs on the subscriptions you already have. The manager and the workers are the official command-line
tools (Claude Code, the Codex CLI, Grok Build), started on your own computer with the logins they already hold.
HeyBotOS has no account, no key and no server of its own, and it never calls a model API.

![The conversation with the manager](docs/assets/screenshot-chat.png)

## Install

| System | How | State |
|---|---|---|
| macOS 12 or newer | `brew install --cask jannikco/tap/heybotos` | Used every day |
| Linux (x64, arm64) | The `.deb` or the `.AppImage` from the [latest release](https://github.com/jannikco/heybotos/releases) | Tried on Linux Mint; new |
| Windows 10 or 11 (x64) | `HeyBotOS-…-win-x64-setup.exe` from the [latest release](https://github.com/jannikco/heybotos/releases) | Experimental, see below |

Then open HeyBotOS. The first time, it shows which of the three tools are installed and signed in, and asks
where your projects are.

### macOS

```sh
brew install --cask jannikco/tap/heybotos
```

> **macOS stops the app the first time you open it**, because it is not notarised by Apple yet. To let it through:
>
> 1. In the message that says HeyBotOS was not opened, choose OK. Do not choose "Move to Trash".
> 2. Open System Settings and go to Privacy & Security.
> 3. Scroll down to Security and choose "Open Anyway" beside the line about HeyBotOS.
> 4. Confirm with your password or Touch ID.
>
> macOS asks again after each update. On a Mac managed by a company, "Open Anyway" can be switched off; then
> build HeyBotOS from source instead (see below), which macOS does not stop.

### Linux

On Debian, Ubuntu and Mint, install the `.deb`:

```sh
sudo apt install ./heybotos_*_amd64.deb     # or _arm64.deb
```

Anywhere else, use the AppImage: make it executable and run it. An AppImage is only there while it runs, and
HeyBotOS keeps a service going after its window is closed, so the first time it copies the app to
`~/.local/share/heybotos/app`, adds an entry to your applications menu and puts the `heybotos` command in
`~/.local/bin`.

```sh
chmod +x HeyBotOS-*.AppImage && ./HeyBotOS-*.AppImage
```

The background service is a systemd user service (`heybotos.service`); where there is no user systemd it is
an autostart entry instead. Notifications use `notify-send`.

### Windows

Run the installer. It installs for you alone, in `%LOCALAPPDATA%\Programs\HeyBotOS`, and asks for no
administrator rights. It is not signed, so Windows says the publisher is unknown the first time: choose
"More info", then "Run anyway".

> **Windows is experimental.** Nobody who works on HeyBotOS has a Windows computer. What is checked, by
> machines, on every change: the tests pass on Windows, the installer installs, the app opens, its service
> starts and answers, and the uninstaller removes it. What nobody has checked: real work with the real
> tools. In particular the gate (the yes or no before a worker reaches a server) relies on how each tool
> starts its commands on Windows, and that has not been seen working. Use it on projects in git, and tell us
> what you find in the [issues](https://github.com/jannikco/heybotos/issues).

The tools need [Git for Windows](https://git-scm.com/download/win) anyway; HeyBotOS uses its `git` too.

### What you need

At least one of these, installed and signed in with a subscription:

| Tool | Command it provides |
|---|---|
| Claude Code | `claude` |
| Codex CLI | `codex` |
| Grok Build | `grok` |

With more than one, HeyBotOS spreads the work across them and sends a review to a different engine than the
one that did the work.

## What you get

| Screen | For |
|---|---|
| Conversations | Talk to the manager, in general or per project. Ask for anything; it answers when work is done or it needs you. |
| Team | Named workers with a role each (engineer, reviewer, researcher, writer, operator). Add your own, or reshape how one works. |
| Inbox | Requests waiting for your yes or no, and questions from workers. |
| Board | Every task by where it stands. |
| Projects | Your project folders, and the notes every worker in a project reads first. |
| Routines | Things the manager does by itself on a schedule. |
| Settings | Engines and their limits, connectors, what needs your approval, the look. |

![Settings: the engines and their limits](docs/assets/screenshot-engines.png)

## How workers are kept in check

Workers run without asking: they edit files and run commands in the project folder. What stands between that
and an accident:

- **You can see and undo it.** Before a task's first worker touches a git repository, HeyBotOS records the
  folder exactly as it is, without touching your branch or staging area. You see what changed since, and one
  button puts those files back.
- **One worker per repository** at a time. A task can ask for its own branch and folder to run alongside.
- **The gate.** Three kinds of action wait for your yes in the Inbox: connecting to a server that is not on
  your list (ssh, scp, sftp, rsync, mosh), deploy and publish commands, and connector calls that change
  something. It is a seatbelt against mistakes, not a sandbox.
- **Connectors are set up once and given per task.** Add an MCP server by web address or command in
  Settings. A worker gets none of them unless its task names them; then it reaches them through HeyBotOS on
  any engine, without ever holding their keys. Reads go straight through; calls that change something wait
  for your yes.
- **Subscriptions only.** Workers get a clean environment built from an allowlist, so no key variable can
  switch a tool to metered billing, and a turn that is not on the subscription login is stopped before it does
  any work.
- **Only this computer.** The service listens on 127.0.0.1 only, and only talks to a browser that you signed in
  from this computer.

## Where things live

| What | macOS | Linux | Windows |
|---|---|---|---|
| The app (it carries the service; no Node needed) | `/Applications/HeyBotOS.app` | `/opt/HeyBotOS` (.deb) or `~/.local/share/heybotos/app` (AppImage) | `%LOCALAPPDATA%\Programs\HeyBotOS` |
| Your data | `~/heybotos` | `~/heybotos` | `%USERPROFILE%\heybotos` |
| Background service | launchd agent `com.heybotos.daemon` | systemd user service `heybotos.service` | started at sign-in from your Run key |
| Terminal command | `heybotos` | `heybotos` | `resources\heybotos\bin\heybotos.cmd` in the app's folder |

Your data folder holds settings in `config/`, the database and logs in `state/`, and attachments in `files/`.
The background service is set up by the app and keeps workers and routines going when the window is closed.
The terminal command takes `open`, `status`, `update`, `logs` and `uninstall`.

To remove HeyBotOS: `brew uninstall --cask heybotos` on macOS, `sudo apt remove heybotos` on Linux (with the
AppImage: run `heybotos uninstall`, then delete `~/.local/share/heybotos`), and "Installed apps" in Settings
on Windows. Run `heybotos uninstall` first where you can: it stops the background service. Your data folder
stays until you delete it.

## Updates

HeyBotOS looks for a newer version a few times a day and tells you in the sidebar when there is one. In
Settings, under General, you see what is new and choose "Update and restart": the app fetches the new
version, replaces itself and opens again. Workers that are running keep running.

- **Nothing is installed without your say**, and looking by itself can be switched off in the same place.
- **Only the project's own releases are accepted.** The list of the newest version is signed with a key that
  is not in this repository, and a download is thrown away unless it matches the checksum in that list.
- **Looking means one request to GitHub** for a small file. It carries nothing about you or your work.
- Installed from the `.deb`, HeyBotOS sits where only the system may write: it fetches the new package and
  shows you the `apt` command that installs it. From the source code, update with `git pull`.

This came with version 0.5.0. From an older version, update once the way you installed it
(`brew upgrade --cask jannikco/tap/heybotos`, or the new file from the releases page).

## Build from source

You need Node 26 and pnpm.

```sh
pnpm install
pnpm start             # builds the dashboard and runs the service in this terminal
pnpm heybotos open     # opens the dashboard with a sign-in link that works once
```

```sh
pnpm demo              # the real service on throwaway data with a stand-in CLI; port 4748
pnpm test              # unit tests; the stand-in CLI replays recorded runs, nothing is spent
pnpm e2e               # browser tests against the demo
pnpm typecheck
pnpm --filter @heybotos/desktop dist   # builds the Mac app into apps/desktop/dist (dist:linux, dist:win elsewhere)
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the layout of the code and the rules for changing it.

## Beta

This is a beta. It is used every day by the people who build it, on macOS. Linux is new and Windows is
experimental (see Install).
Things will change between versions, sometimes in ways that need a manual step; [CHANGELOG.md](CHANGELOG.md)
says what changed. Bug reports and ideas are very welcome in the
[issues](https://github.com/jannikco/heybotos/issues).

## Licence

[MIT](LICENSE). The fonts and libraries it ships with are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Claude, Codex and Grok are products of their own companies;
HeyBotOS is not affiliated with any of them.
