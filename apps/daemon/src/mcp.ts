// The manager agent's hands: a small MCP server (Streamable HTTP, stateless, JSON replies) that the
// daemon serves on loopback. Only the manager's session gets the token for it.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectView, TaskView } from '@heybotos/protocol'
import type { Home } from './home.ts'
import type { Registry } from './registry.ts'
import type { Tasks } from './tasks.ts'
import type { Routines } from './routines.ts'
import type { Staff } from './staff.ts'
import type { Settings } from './settings.ts'
import type { Supervisor } from './engines/supervisor.ts'
import { oneLine } from './engines/redact.ts'

type Args = Record<string, unknown>

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Args): unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clipped = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null)

function need(args: Args, key: string): string {
  const v = str(args[key]).trim()
  if (!v) throw new Error(`"${key}" is required.`)
  return v
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const taskLine = (t: TaskView) => ({
  task: t.key,
  task_id: t.id,
  project: t.project,
  title: t.title,
  kind: t.kind,
  status: t.status === 'todo' ? 'backlog' : t.status,
  ...(t.tier === 'epic' ? { epic: true } : {}),
  ...(t.priority !== 'normal' ? { priority: t.priority } : {}),
  ...(t.labels.length ? { labels: t.labels } : {}),
  ...(t.dueAt ? { due: day(t.dueAt) } : {}),
  ...(t.counts.children ? { sub_tasks: `${t.counts.childrenDone} of ${t.counts.children} done` } : {}),
  ...(t.waitReason ? { waiting_for: t.waitReason } : {}),
  ...(t.question ? { question: t.question } : {}),
  ...(t.summary ? { summary: clipped(t.summary, 500) } : {}),
  ...(t.dependsOn.length ? { depends_on: t.dependsOn } : {}),
  ...(t.parentId ? { parent_id: t.parentId } : {}),
  ...(t.assigneeName ? { assignee: t.assigneeName } : {}),
  ...(t.connectors.length ? { connectors: t.connectors } : {}),
})

const projectLine = (p: ProjectView) => ({
  project: p.slug,
  name: p.name,
  kind: p.kind,
  ...(p.stack ? { stack: p.stack } : {}),
  ...(p.description ? { about: clipped(p.description, 160) } : {}),
  ...(p.dirty ? { uncommitted_changes: true } : {}),
  ...(p.openTasks ? { open_tasks: p.openTasks } : {}),
  ...(p.lastCommitAt ? { last_commit: new Date(p.lastCommitAt).toISOString().slice(0, 10) } : {}),
})

export function managerTools(deps: { home: Home; registry: Registry; tasks: Tasks; supervisor: Supervisor; routines: Routines; connectorNames?: string[]; trustedConnectors?: string[]; rename?: (name: string) => string; staff?: Staff; settings?: Settings }): ToolDef[] {
  const { home, registry, tasks, supervisor, routines } = deps
  const connectorNames = deps.connectorNames ?? []
  const trusted = deps.trustedConnectors ?? []
  const project = (args: Args): ProjectView => {
    const ref = need(args, 'project')
    const p = registry.find(ref)
    if (!p) throw new Error(`No project called "${ref}". Use list_projects with a search word to find its name.`)
    return p
  }
  const task = (args: Args): TaskView => {
    const id = need(args, 'task_id')
    const t = tasks.resolve(id)
    if (!t) throw new Error(`No task "${id}". Use list_tasks or search_tasks to find it; a task is named by its key (like BOT-12) or its id.`)
    return t
  }
  const dueOf = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    const ms = Date.parse(`${str(v)}T12:00:00`)
    if (Number.isNaN(ms)) throw new Error('"due" is a date like 2026-11-20.')
    return ms
  }

  return [
    {
      name: 'list_projects',
      description:
        "List the owner's projects, most recently active first. Pass a search word to narrow it down (matches name, stack and description). Returns at most 40; search rather than scrolling.",
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words that must all appear in the name, stack or description.' } } },
      run(args) {
        const words = str(args.query).toLowerCase().split(/\s+/).filter(Boolean)
        const all = registry.list().filter((p) => !p.missing && (words.length > 0 || !p.parentSlug))
        const hits = all.filter((p) => words.every((w) => `${p.name} ${p.slug} ${p.stack} ${p.description}`.toLowerCase().includes(w)))
        return { total: hits.length, shown: Math.min(hits.length, 40), projects: hits.slice(0, 40).map(projectLine) }
      },
    },
    {
      name: 'get_project',
      description: 'Everything about one project: folder, stack, the notes kept for workers, and its recent tasks.',
      inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string', description: 'Project name or id from list_projects.' } } },
      run(args) {
        const p = project(args)
        return {
          ...projectLine(p),
          folder: p.path,
          is_git_repository: p.isGit,
          has_own_instructions_file: p.hasInstructions,
          notes_for_workers: p.notes,
          linked_worktrees: registry.list().filter((x) => x.parentSlug === p.slug).map((x) => x.slug),
          recent_tasks: tasks.list({ project: p.slug }, 15).map(taskLine),
        }
      },
    },
    {
      name: 'create_project',
      description: 'Add a project that is not code (research, writing, planning). It gets its own folder for notes and files. Code projects are found automatically; do not create them here.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string', description: 'One or two sentences on what it is about.' } } },
      run(args) {
        return projectLine(registry.createOther(need(args, 'name'), str(args.description)))
      },
    },
    {
      name: 'update_project_notes',
      description: 'Replace the notes kept for one project. Every worker in that project reads them before it starts, so keep them short and lasting: where things are deployed, what must not be touched, decisions made.',
      inputSchema: { type: 'object', required: ['project', 'notes'], properties: { project: { type: 'string' }, notes: { type: 'string', description: 'The complete new notes; this replaces what was there.' } } },
      run(args) {
        const p = project(args)
        registry.setNotes(p.slug, str(args.notes).slice(0, 20_000))
        return { saved: true, project: p.slug }
      },
    },
    {
      name: 'create_task',
      description:
        'Give a worker agent a task in a project. The worker starts with no memory of your conversation: the brief is all it knows, so write it for a newcomer (goal, what done looks like and how to check it, what not to touch, what you already know). It starts at once unless it depends on unfinished tasks.',
      inputSchema: {
        type: 'object',
        required: ['project', 'title', 'brief'],
        properties: {
          project: { type: 'string', description: 'Project name or id.' },
          title: { type: 'string', description: 'A short name for the task, as the owner would recognise it.' },
          brief: { type: 'string', description: 'The full instructions for the worker.' },
          kind: { type: 'string', enum: ['build', 'review', 'research', 'write', 'ops', 'other'], description: 'review and research workers are told not to change project files.' },
          assignee: { type: 'string', description: 'The team member to give it to, by name (see list_team). Leave out and it goes to whoever takes that kind of work.' },
          engine: { type: 'string', enum: ['claude', 'codex', 'grok'], description: 'Leave out: HeyBotOS spreads work across the engines by itself. Name one only when the owner asks for it.' },
          model: { type: 'string', description: 'A specific model for this task, exactly as the owner named it. Leave out unless they asked for one.' },
          effort: { type: 'string', description: 'A specific effort level for this task (for example low, medium, high). Leave out unless the owner asked.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Tasks (keys or ids) that must be done before this one starts.' },
          parent_id: { type: 'string', description: 'The task or epic this one belongs under (key or id). When a request becomes several tasks, make one parent first and put the others under it.' },
          epic: { type: 'boolean', description: 'true = this is an epic: a container for other tasks. It gets no worker and never starts.' },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'], description: 'Leave out for normal.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Short labels, like "bug" or "checkout".' },
          due: { type: 'string', description: 'A date it should be done by, as YYYY-MM-DD. Only when the owner named one.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths of files the owner attached that the worker needs. The worker is told where they are.' },
          connectors: {
            type: 'array',
            items: { type: 'string' },
            description: `The owner's connectors (tools from outside: a browser, their own systems, MCP servers) this worker may use${connectorNames.length ? `. Available: ${connectorNames.map((n) => `${n}${trusted.includes(n) ? ' (trusted)' : ''}`).join(', ')}` : ' (none are set up)'}. Leave it out and the worker gets the ones the owner set for the project. They work on every engine. With only trusted connectors a worker keeps everything else it can do. With one that is not marked trusted it cannot run commands that change things or run tests: split such work into two tasks, or tell the owner they can mark the connector as trusted in Settings, under Connectors.`,
          },
          separate_copy: { type: 'boolean', description: 'Work on its own branch in its own folder (git worktree), so it can run at the same time as another task in the same repository.' },
          start: { type: 'boolean', description: 'false = put it in the backlog without starting it. Use it when the owner says "note", "later", "backlog" or "do not start yet".' },
        },
      },
      run(args) {
        const p = project(args)
        const kind = str(args.kind) as TaskView['kind']
        const t = tasks.create(
          {
            project: p.slug,
            title: need(args, 'title'),
            brief: need(args, 'brief'),
            kind: kind || undefined,
            engine: args.engine === 'codex' || args.engine === 'claude' || args.engine === 'grok' ? args.engine : undefined,
            dependsOn: Array.isArray(args.depends_on) ? args.depends_on.map(String) : undefined,
            parentId: str(args.parent_id) || undefined,
            isolation: args.separate_copy === true ? 'worktree' : 'direct',
            connectors: Array.isArray(args.connectors) ? args.connectors.map(String) : undefined,
            assignee: str(args.assignee) || undefined,
            model: str(args.model) || undefined,
            effort: str(args.effort) || undefined,
            start: args.start !== false,
            tier: args.epic === true ? 'epic' : 'task',
            priority: (str(args.priority) || undefined) as TaskView['priority'] | undefined,
            labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
            dueAt: dueOf(args.due) ?? null,
            files: Array.isArray(args.files) ? args.files.map(String) : undefined,
          },
          'manager',
        )
        return { created: true, ...taskLine(t), note: 'You will get its report at the start of a later turn. Do not wait or poll for it.' }
      },
    },
    {
      name: 'list_tasks',
      description: 'The task list. By default only tasks that are not finished; pass which="all" for recent finished ones too.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, which: { type: 'string', enum: ['open', 'all'] } } },
      run(args) {
        const slug = str(args.project) ? project(args).slug : undefined
        const list = tasks.list({ project: slug, open: args.which !== 'all' }, 60)
        return { count: list.length, tasks: list.map(taskLine) }
      },
    },
    {
      name: 'get_task',
      description: 'One task in full: its brief, state, the worker\'s report (summary, how it checked, follow-ups) and which files changed.',
      inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
      run(args) {
        const t = task(args)
        const runs = tasks.runs(t.id)
        const last = runs.at(-1)
        const changes = t.hasBaseline ? tasks.changes(t.id) : null
        const d = tasks.detail(t.id)!
        return {
          ...taskLine(t),
          summary: t.summary,
          brief: t.brief,
          ...(d.parent ? { under: `${d.parent.key} ${d.parent.title}` } : {}),
          ...(d.children.length ? { sub_tasks: d.children.map((c) => `${c.key} [${c.status === 'todo' ? 'backlog' : c.status}] ${c.title}`) } : {}),
          ...(d.blockedBy.length ? { blocked_by: d.blockedBy.map((b) => `${b.key} [${b.status}] ${b.title}`) } : {}),
          ...(d.links.length ? { links: d.links.map((l) => `${l.type === 'relates' ? 'relates to' : l.outward ? 'duplicates' : 'is duplicated by'} ${l.task.key} ${l.task.title}`) } : {}),
          ...(d.files.length ? { files: d.files.map((f) => f.path) } : {}),
          ...(d.comments.length ? { comments: d.comments.slice(-20).map((c) => `${c.author === 'user' ? 'Owner' : c.authorName}, ${day(c.createdAt)}: ${clipped(c.text, 600)}`) } : {}),
          turns: runs.length,
          folder: t.cwd,
          report: last?.report ?? null,
          worker_error: last?.error ?? null,
          files_changed: changes?.available ? changes.files.slice(0, 60).map((f) => `${f.status} ${f.path} (+${f.added} -${f.removed})`) : (changes?.reason ?? 'Not recorded.'),
        }
      },
    },
    {
      name: 'get_task_log',
      description: "What a task's worker actually did in its latest turn: what it said and each step it took, oldest first. Use it when a report is thin or something looks off.",
      inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' }, last: { type: 'number', description: 'How many lines from the end (default 40, at most 200).' } } },
      run(args) {
        const t = task(args)
        if (!t.lastRunId) return { lines: [], note: 'This task has not started yet.' }
        const lines: string[] = []
        for (const e of supervisor.events(t.lastRunId)) {
          if (e.kind === 'text') lines.push(`said: ${oneLine(e.data.text, 400)}`)
          else if (e.kind === 'tool_start') lines.push(`${e.parent ? '  (sub-agent) ' : ''}did: ${oneLine(e.data.label, 200)}`)
          else if (e.kind === 'tool_result' && e.data.isError === true) lines.push(`  failed: ${oneLine(e.data.text, 300)}`)
          else if (e.kind === 'error') lines.push(`error: ${oneLine(e.data.message, 300)}`)
        }
        const n = Math.min(200, Math.max(1, Number(args.last) || 40))
        return { total_lines: lines.length, lines: lines.slice(-n) }
      },
    },
    {
      name: 'message_task',
      description: 'Send a message to a task\'s worker: answer its question, correct it, or ask for more. The same worker session continues with your message. Not possible while it is working.',
      inputSchema: { type: 'object', required: ['task_id', 'message'], properties: { task_id: { type: 'string' }, message: { type: 'string' } } },
      run(args) {
        return { sent: true, ...taskLine(tasks.answer(task(args).id, need(args, 'message'))) }
      },
    },
    {
      name: 'start_task',
      description: 'Start a task that was created without starting, or start a stopped or failed one again.',
      inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
      run(args) {
        return taskLine(tasks.start(task(args).id))
      },
    },
    {
      name: 'update_task',
      description: 'Change a task: its title, brief, kind, priority, labels, due date, who does it, what it waits for, or what it sits under. Only what you pass is changed. Who does it and on what cannot change while a worker is on it.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Key (BOT-12) or id.' },
          title: { type: 'string' },
          brief: { type: 'string', description: 'The whole new brief; it replaces the old one.' },
          kind: { type: 'string', enum: ['build', 'review', 'research', 'write', 'ops', 'other'] },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
          labels: { type: 'array', items: { type: 'string' }, description: 'The whole new list.' },
          due: { type: 'string', description: 'YYYY-MM-DD, or an empty text to take the date off.' },
          assignee: { type: 'string', description: 'A team member by name.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'The whole new list of tasks it waits for.' },
          parent_id: { type: 'string', description: 'The task or epic it belongs under; an empty text takes it out.' },
        },
      },
      run(args) {
        const t = task(args)
        return {
          changed: true,
          ...taskLine(
            tasks.update(
              t.id,
              {
                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                ...(typeof args.brief === 'string' ? { brief: args.brief } : {}),
                ...(typeof args.kind === 'string' ? { kind: args.kind as TaskView['kind'] } : {}),
                ...(typeof args.priority === 'string' ? { priority: args.priority as TaskView['priority'] } : {}),
                ...(Array.isArray(args.labels) ? { labels: args.labels.map(String) } : {}),
                ...(args.due !== undefined ? { dueAt: dueOf(args.due) ?? null } : {}),
                ...(typeof args.assignee === 'string' && args.assignee ? { assignee: args.assignee } : {}),
                ...(Array.isArray(args.depends_on) ? { dependsOn: args.depends_on.map(String) } : {}),
                ...(typeof args.parent_id === 'string' ? { parentId: args.parent_id || null } : {}),
              },
              'manager',
            ),
          ),
        }
      },
    },
    {
      name: 'move_task',
      description: 'Move a task on the board. backlog = park it (a working worker is stopped); start = start it; done = close it by hand as done; wont_do = close it as not to be done. A task reaches "needs you" and "done" by itself when its worker reports.',
      inputSchema: { type: 'object', required: ['task_id', 'to'], properties: { task_id: { type: 'string' }, to: { type: 'string', enum: ['backlog', 'start', 'done', 'wont_do'] } } },
      run(args) {
        const to = need(args, 'to')
        if (!['backlog', 'start', 'done', 'wont_do'].includes(to)) throw new Error('"to" is backlog, start, done or wont_do.')
        return taskLine(tasks.move(task(args).id, { stage: to === 'backlog' ? 'backlog' : to === 'start' ? 'next' : 'done', wontDo: to === 'wont_do' }, 'manager'))
      },
    },
    {
      name: 'comment_task',
      description: 'Write a comment on a task, for the owner and for whoever works on it next. It does not wake the worker: use message_task for that.',
      inputSchema: { type: 'object', required: ['task_id', 'comment'], properties: { task_id: { type: 'string' }, comment: { type: 'string' } } },
      run(args) {
        const t = task(args)
        tasks.comment(t.id, 'manager', need(args, 'comment'))
        return { commented: true, task: t.key }
      },
    },
    {
      name: 'link_tasks',
      description: 'Link two tasks: "relates" when they concern the same thing, "duplicates" when the first is the same work as the second. For "must wait for", use depends_on instead.',
      inputSchema: { type: 'object', required: ['task_id', 'other', 'type'], properties: { task_id: { type: 'string' }, other: { type: 'string', description: 'The other task, by key or id.' }, type: { type: 'string', enum: ['relates', 'duplicates'] } } },
      run(args) {
        const t = task(args)
        tasks.link(t.id, need(args, 'other'), need(args, 'type') as 'relates' | 'duplicates', 'manager')
        return { linked: true, task: t.key }
      },
    },
    {
      name: 'search_tasks',
      description: 'Find tasks by words in their title, brief, labels, comments or file names, open or finished. A key like BOT-12 finds that task.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      run(args) {
        const found = tasks.search(need(args, 'query'), 40)
        return { count: found.length, tasks: found.map(taskLine) }
      },
    },
    {
      name: 'stop_task',
      description: 'Stop a working task, or cancel one that has not started. What the worker already changed stays; the owner can undo it from the dashboard.',
      inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
      run(args) {
        return taskLine(tasks.stop(task(args).id))
      },
    },
    {
      name: 'list_team',
      description: 'Your team: each member with their role, the kinds of work that go to them, what they are doing now and their track record.',
      inputSchema: { type: 'object', properties: {} },
      run() {
        return {
          team: (deps.staff?.list() ?? []).filter((m) => !m.isChief).map((m) => ({ id: m.id, name: m.name, role: m.title, takes: m.focus, engine: m.engine, active: m.active, working_on: m.currentTaskId, done: m.stats.done, failed: m.stats.failed, open: m.stats.open })),
        }
      },
    },
    {
      name: 'save_team_member',
      description: 'Add a team member, or change one (name, role, the kinds of work they take, engine, how they work). Only when the owner asks for a change to the team. Give id to change an existing member; leave it out to add one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the member to change, from list_team.' },
          name: { type: 'string' },
          role: { type: 'string', description: 'Their title, like "Designer" or "Bookkeeper".' },
          takes: { type: 'array', items: { type: 'string', enum: ['build', 'review', 'research', 'write', 'ops', 'other'] }, description: 'Kinds of work that go to them by default.' },
          engine: { type: 'string', enum: ['auto', 'claude', 'codex', 'grok'] },
          persona: { type: 'string', description: 'How they work and what they care about, written to them as "You ...".' },
          active: { type: 'boolean', description: 'false retires them: they keep their history but get no new work.' },
        },
      },
      run(args) {
        if (!deps.staff) throw new Error('The team is not available here.')
        const m = deps.staff.save({
          id: str(args.id) || undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          title: typeof args.role === 'string' ? args.role : undefined,
          focus: Array.isArray(args.takes) ? args.takes.map(String) : undefined,
          engine: typeof args.engine === 'string' ? args.engine : undefined,
          persona: typeof args.persona === 'string' ? args.persona : undefined,
          active: typeof args.active === 'boolean' ? args.active : undefined,
        })
        return { saved: true, id: m.id, name: m.name, role: m.title, takes: m.focus, active: m.active }
      },
    },
    {
      name: 'get_settings',
      description: 'How HeyBotOS is set up right now: workers at once, which engine does which kind of work, the servers workers may reach without asking, connector tools that may change things without asking, models.',
      inputSchema: { type: 'object', properties: {} },
      run() {
        if (!deps.settings) throw new Error('Settings are not available here.')
        const { paths: _paths, ...rest } = deps.settings.read()
        return rest
      },
    },
    {
      name: 'change_settings',
      description:
        'Change how HeyBotOS is set up, when the owner asks. Pass only what changes, in the same shape get_settings returns, for example {"general":{"maxWorkers":4}} or {"gate":{"allowedHosts":[...the full new list...]}}. Lists are replaced whole, so read the current one first. Loosening the gate (adding a server or an always-allowed tool) is the owner\'s call: do it only on a clear instruction, and say back exactly what you changed.',
      inputSchema: {
        type: 'object',
        properties: {
          general: { type: 'object', description: 'maxWorkers (1-12), notifications (true/false), projectRoots (list of folders).' },
          manager: { type: 'object', description: 'model, effort, batchSeconds.' },
          engines: { type: 'object', description: '{ claude: { model, effort }, codex: { model, effort } }' },
          routing: { type: 'object', description: 'byKind (kind -> claude|codex), fallback (true/false), headroom (engine -> 0.5..1).' },
          gate: { type: 'object', description: 'allowedHosts, alwaysAllowTools ("connector/tool"), askCommandPatterns, hostGrantMinutes.' },
        },
      },
      run(args) {
        if (!deps.settings) throw new Error('Settings are not available here.')
        const { paths: _paths, ...rest } = deps.settings.apply(args as never)
        return { changed: true, now: rest }
      },
    },
    {
      name: 'set_server_access',
      description:
        "Give the team standing SSH access to one of the owner's servers (they then connect without asking), or take it away again (each connection then waits for the owner's yes). Workers use the owner's own SSH config and keys. Only on the owner's clear instruction for that server, and say back exactly what changed.",
      inputSchema: { type: 'object', required: ['server', 'access'], properties: { server: { type: 'string', description: 'The server as the owner names it in ssh, for example "web1".' }, access: { type: 'string', enum: ['always', 'ask'] } } },
      run(args) {
        if (!deps.settings) throw new Error('Settings are not available here.')
        const server = need(args, 'server').toLowerCase()
        const now = deps.settings.read().gate.allowedHosts
        const next = args.access === 'always' ? [...new Set([...now, server])] : now.filter((h) => h !== server)
        return { server, access: args.access === 'always' ? 'always' : 'ask', allowed_servers: deps.settings.apply({ gate: { allowedHosts: next } }).gate.allowedHosts }
      },
    },
    {
      name: 'create_routine',
      description:
        'Set up something you will do by yourself on a schedule: a morning brief, a nightly check, a weekly review. When it comes due you get the prompt at the start of a turn, as if the owner had asked. Only create one when the owner asks for something recurring.',
      inputSchema: {
        type: 'object',
        required: ['title', 'schedule', 'prompt'],
        properties: {
          title: { type: 'string', description: 'A short name, as the owner would say it.' },
          schedule: { type: 'string', description: 'Five-field cron in the owner\'s local time: minute hour day-of-month month day-of-week. "30 7 * * 1-5" = weekdays at 07:30; "0 9 * * 1" = Mondays at 09:00.' },
          prompt: { type: 'string', description: 'What you should do each time, written so it makes sense on its own months from now.' },
        },
      },
      run(args) {
        const r = routines.create({ title: need(args, 'title'), schedule: need(args, 'schedule'), prompt: need(args, 'prompt') }, 'manager')
        return { created: true, routine_id: r.id, when: r.when, next: r.nextAt ? new Date(r.nextAt).toString() : null }
      },
    },
    {
      name: 'list_routines',
      description: 'The routines that are set up, with when each comes due next.',
      inputSchema: { type: 'object', properties: {} },
      run() {
        return { routines: routines.list().map((r) => ({ routine_id: r.id, title: r.title, when: r.when, enabled: r.enabled, next: r.nextAt ? new Date(r.nextAt).toString() : null, prompt: r.prompt })) }
      },
    },
    {
      name: 'delete_routine',
      description: 'Remove a routine for good. Only when the owner asks.',
      inputSchema: { type: 'object', required: ['routine_id'], properties: { routine_id: { type: 'string' } } },
      run(args) {
        routines.remove(need(args, 'routine_id'))
        return { deleted: true }
      },
    },
    {
      name: 'set_your_name',
      description: 'Change the name you go by: the owner sees it across HeyBotOS (navigation, the orbit, the conversation) and you answer to it from now on. Use it when the owner asks you to rename yourself or gives you a title, for example "Chief of Staff".',
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'The new name or title, as the owner wrote it, with normal capitalisation and spelling.' } } },
      run(args) {
        if (!deps.rename) throw new Error('Renaming is not available here.')
        return { renamed: true, name: deps.rename(need(args, 'name')) }
      },
    },
    {
      name: 'save_owner_notes',
      description: 'Replace your lasting notes about the owner: how they like to work, standing wishes, things to remember across sessions. You see these notes at the start of every new session. Keep them short.',
      inputSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'string', description: 'The complete new notes; this replaces what was there.' } } },
      run(args) {
        writeFileSync(join(home.manager, 'owner-notes.md'), str(args.notes).slice(0, 12_000))
        return { saved: true }
      },
    },
  ]
}

// ── JSON-RPC over HTTP ───────────────────────────────────────────────────────────────────────

interface Rpc {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, any>
}

function answer(tools: ToolDef[], version: string, req: Rpc): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } })
  // Notifications carry no id and get no answer.
  if (req.id === undefined || req.id === null) return req.method ? null : fail(-32600, 'Not a valid request.')
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'heybotos', version },
        instructions: 'Tools for managing the owner\'s projects and the worker agents HeyBotOS runs.',
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === req.params?.name)
      if (!tool) return fail(-32602, `No tool called "${req.params?.name}".`)
      try {
        const out = tool.run((req.params?.arguments ?? {}) as Args)
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] })
      } catch (e) {
        // A tool that could not do its job answers in words the model can act on.
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    }
    default:
      return fail(-32601, `Method "${req.method}" is not supported.`)
  }
}

/** Handle one HTTP body: a request, a notification, or a batch. Returns null when there is nothing to send back. */
export function handleMcp(tools: ToolDef[], version: string, body: unknown): unknown | null {
  if (Array.isArray(body)) {
    const out = body.map((r) => answer(tools, version, r as Rpc)).filter((r) => r !== null)
    return out.length ? out : null
  }
  if (body === null || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read the request.' } }
  return answer(tools, version, body as Rpc)
}
