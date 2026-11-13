# Changelog

## Not released yet

- **HeyBotOS updates itself.** It looks for a newer version now and then and says so in the sidebar. In
  Settings, General, Version you see what is new and choose "Update and restart": the app fetches the new
  version, checks that it is the one the project published, replaces itself and opens again. Workers keep
  running through it. Looking by itself can be switched off, and nothing is installed without your say.
- Where the app cannot replace itself (installed from the `.deb`), it fetches the new package and gives
  you the one command that installs it.
- `heybotos update` in a terminal says whether there is a newer version.

This is the first version that can do this: from 0.4.0 or older, update once the way you installed it.

## 0.4.0 (beta)

- **Linux.** The desktop app as a `.deb` (Debian, Ubuntu, Mint) and an AppImage, for x64 and arm64. The
  background service is a systemd user service; workers' shells keep the gate's wrappers in front in bash
  as they already did in zsh.
- **Windows (experimental).** An installer for Windows 10 and 11 that needs no administrator rights. The
  tests pass and the app, its service and the installer are tried by machines on every change, but nobody
  has done real work with it on Windows yet.
- The dashboard no longer says "this Mac".

## 0.3.1 (beta)

- Attach files to a message: pick them with the paperclip, drop them on the conversation, or paste a
  screenshot. The manager gets them with the message and can hand them on to a worker.
- The message field grows with what you write.
- A connector name can be typed with spaces: "My CRM" is kept as "My-CRM", the form every engine takes.
- The app carries its build time as its date, so an update shows its own icon in the Dock.

## 0.3.0 (beta)

The first public version, and a beta: expect rough edges and changes between versions.

- The Mac app carries everything: the service, the dashboard, the prompts and the gate scripts. It sets up
  its own background service and needs no Node installed.
- A manager you talk to, in a general conversation and one per project, and a team of named workers.
- Three engines: Claude Code, the Codex CLI and Grok Build, each on its own subscription login. Work is
  spread across them automatically, or by kind of work; a full limit moves waiting work to another engine.
- The gate: reaching a server that is not on your list, deploying or publishing, and connector calls that
  change something wait for your yes in the Inbox.
- Connectors (MCP servers) set up once and usable from every engine, with keys that never leave the service.
- A record of the project folder before a worker starts, a view of what changed, and one-button undo.
- Routines on a schedule, a usage view per subscription, and settings that save as you change them.
- Markdown in answers and reports: tables, nested lists, task lists, code blocks with a copy button.
- Tasks have keys such as `BOT-12`. The service already keeps a backlog, priorities, labels, due dates,
  comments, attachments and links for them; the pages for these arrive in the next version.
