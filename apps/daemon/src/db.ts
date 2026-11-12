// Storage. Built-in SQLite, kept behind this small wrapper because node:sqlite is still a release candidate.
import { chmodSync, existsSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export const MIGRATIONS: string[] = [
  `
  create table runs (
    id text primary key,
    task_id text,
    engine text not null,
    role text,
    title text not null,
    prompt text not null,
    cwd text not null,
    session_id text,
    turn integer not null default 1,
    status text not null,
    pid integer,
    pid_started text,
    model text,
    effort text,
    activity text,
    error text,
    result_text text,
    report_json text,
    cost_usd real,
    tokens_in integer,
    tokens_out integer,
    stdout_path text,
    stdout_offset integer not null default 0,
    stop_requested integer not null default 0,
    stop_reason text,
    extra_json text,
    created_at integer not null,
    started_at integer,
    ended_at integer
  );
  create index runs_status on runs(status);
  create index runs_task on runs(task_id);

  create table events (
    id integer primary key autoincrement,
    run_id text not null,
    ts integer not null,
    kind text not null,
    parent text,
    data text not null
  );
  create index events_run on events(run_id, id);

  create table sessions (
    hash text primary key,
    created_at integer not null,
    last_seen integer not null
  );

  create table meta (key text primary key, value text not null);
  `,
  `
  alter table runs add column lock_key text;

  create table projects (
    slug text primary key,
    name text not null,
    path text not null unique,
    kind text not null default 'code',
    description text not null default '',
    stack text not null default '',
    is_git integer not null default 0,
    git_common_dir text,
    parent_slug text,
    last_commit_at integer,
    dirty integer not null default 0,
    has_instructions integer not null default 0,
    missing integer not null default 0,
    notes text not null default '',
    created_at integer not null,
    scanned_at integer
  );

  create table tasks (
    id text primary key,
    project_slug text not null,
    parent_id text,
    title text not null,
    brief text not null,
    kind text not null default 'other',
    status text not null,
    wait_reason text,
    engine text not null default 'claude',
    role text,
    depends_on text not null default '[]',
    isolation text not null default 'direct',
    cwd text not null,
    lock_key text not null,
    baseline text,
    after text,
    question text,
    summary text,
    created_by text not null default 'user',
    created_at integer not null,
    updated_at integer not null
  );
  create index tasks_project on tasks(project_slug);
  create index tasks_status on tasks(status);
  `,
  `
  create table approvals (
    id text primary key,
    run_id text not null,
    task_id text,
    scope text not null,
    kind text not null,
    fingerprint text not null,
    summary text not null,
    detail text not null,
    status text not null default 'pending',
    note text,
    uses_left integer not null default 0,
    expires_at integer,
    notified integer not null default 0,
    created_at integer not null,
    decided_at integer
  );
  create index approvals_scope on approvals(scope, fingerprint);
  create index approvals_status on approvals(status);
  `,
  `
  create table messages (
    id integer primary key autoincrement,
    role text not null,
    text text not null,
    run_id text,
    created_at integer not null
  );

  create table manager_inbox (
    id integer primary key autoincrement,
    kind text not null,
    text text not null,
    task_id text,
    created_at integer not null,
    delivered_run_id text
  );
  create index manager_inbox_open on manager_inbox(delivered_run_id);
  `,
  `
  alter table runs add column limited integer not null default 0;
  `,
  `
  create table routines (
    id text primary key,
    title text not null,
    schedule text not null,
    prompt text not null,
    enabled integer not null default 1,
    created_by text not null default 'user',
    created_at integer not null,
    last_fired_at integer,
    next_at integer
  );
  alter table tasks add column connectors text not null default '[]';
  `,
  `
  create table staff (
    id text primary key,
    name text not null,
    title text not null,
    focus text not null default '[]',
    engine text not null default 'auto',
    model text not null default '',
    effort text not null default '',
    persona text not null default '',
    memory text not null default '',
    hue integer not null default 220,
    active integer not null default 1,
    created_at integer not null
  );
  alter table tasks add column assignee text;
  `,
  `
  alter table messages add column thread text not null default 'chief';
  alter table manager_inbox add column thread text not null default 'chief';
  create index messages_thread on messages(thread, id);
  create table thread_reads (thread text primary key, read_at integer not null);
  `,
  `
  alter table tasks add column model text not null default '';
  alter table tasks add column effort text not null default '';
  `,
  `
  -- HeyBotOS's own connectors. headers and env can hold keys, which is why the database file is owner-only.
  create table connectors (
    name text primary key,
    transport text not null,
    url text,
    headers text not null default '{}',
    command text,
    args text not null default '[]',
    env text not null default '{}',
    enabled integer not null default 1,
    source text not null default 'added here',
    tools text not null default '[]',
    last_error text,
    checked_at integer,
    created_at integer not null
  );
  `,
  `
  -- Tokens from a sign-in through the browser, for connectors that want one.
  alter table connectors add column oauth text;
  `,
  `
  -- The tracker: every project gets a key and every task a number (BOT-12), and a task gets the
  -- fields, comments, links, files and history a ticket has.
  alter table projects add column key text;
  alter table projects add column next_number integer not null default 1;
  alter table projects add column starred integer not null default 0;
  create unique index projects_key on projects(key) where key is not null;

  alter table tasks add column number integer;
  alter table tasks add column tier text not null default 'task';
  alter table tasks add column priority text not null default 'normal';
  alter table tasks add column labels text not null default '[]';
  alter table tasks add column due_at integer;
  alter table tasks add column rank real not null default 0;
  alter table tasks add column closed_by text;
  -- Set when who does it (or on what) changed: the next start is a new session, not the old one resumed.
  alter table tasks add column fresh integer not null default 0;
  update tasks set rank = created_at;
  create index tasks_parent on tasks(parent_id);

  create table task_comments (
    id integer primary key autoincrement,
    task_id text not null,
    author text not null,
    text text not null,
    sent integer not null default 0,
    delivered integer not null default 0,
    created_at integer not null,
    edited_at integer
  );
  create index task_comments_task on task_comments(task_id, id);

  create table task_links (
    id integer primary key autoincrement,
    from_id text not null,
    to_id text not null,
    type text not null,
    created_at integer not null,
    unique (from_id, to_id, type)
  );

  create table task_history (
    id integer primary key autoincrement,
    task_id text not null,
    at integer not null,
    actor text not null,
    what text not null,
    old text,
    new text
  );
  create index task_history_task on task_history(task_id, id);

  -- A file lives once on disk and can hang on several things (a message and the task made from it).
  create table files (
    id text primary key,
    name text not null,
    mime text not null,
    size integer not null,
    path text not null,
    created_by text not null default 'user',
    created_at integer not null
  );
  create table file_links (
    file_id text not null,
    owner_kind text not null,
    owner_id text not null,
    created_at integer not null,
    primary key (file_id, owner_kind, owner_id)
  );
  create index file_links_owner on file_links(owner_kind, owner_id);

  create table task_filters (
    id integer primary key autoincrement,
    name text not null,
    query text not null,
    created_at integer not null
  );
  `,
]

export class Db {
  readonly raw: DatabaseSync

  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    // Connector keys live in here: nobody but the owner reads the file.
    if (path !== ':memory:') for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600)
    this.raw.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on; pragma busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    this.raw.exec('create table if not exists schema_version (v integer not null)')
    const row = this.raw.prepare('select max(v) as v from schema_version').get() as { v: number | null }
    const current = row.v ?? 0
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]!)
        this.raw.prepare('insert into schema_version (v) values (?)').run(i + 1)
      })
    }
  }

  journalMode(): string {
    return (this.raw.prepare('pragma journal_mode').get() as { journal_mode: string }).journal_mode
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastId: number } {
    const r = this.raw.prepare(sql).run(...params)
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }

  /** Run fn in one transaction. Nested calls join the outer transaction. */
  private depth = 0
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.raw.exec('begin immediate')
    this.depth++
    try {
      const out = fn()
      this.raw.exec('commit')
      return out
    } catch (e) {
      this.raw.exec('rollback')
      throw e
    } finally {
      this.depth--
    }
  }

  close(): void {
    this.raw.close()
  }
}
