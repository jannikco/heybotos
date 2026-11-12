# Changelog

## 0.3.0

The first public version.

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
