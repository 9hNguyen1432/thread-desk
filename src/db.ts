import Database from 'better-sqlite3';
import { join } from 'node:path';

export type DB = Database.Database;

const SCHEMA_VERSION = 5;
/** Databases older than this need derived tables rebuilt instead of only new tables added. */
const LAST_DESTRUCTIVE_VERSION = 2;

const SCHEMA = `
create table if not exists sessions (
  id text primary key,
  file text not null,
  cwd text,
  project text,
  git_branch text,
  custom_title text,
  ai_title text,
  agent_name text,
  first_prompt text,
  last_prompt text,
  last_assistant text,
  first_at integer,
  last_at integer,
  last_human_at integer,
  last_assistant_at integer,
  human_count integer not null default 0,
  message_count integer not null default 0,
  claude_version text,
  continued_in text,
  transcript_exists integer not null default 1
);

create table if not exists files (
  path text primary key,
  session_id text not null,
  offset integer not null,
  size integer not null,
  mtime integer not null
);

create table if not exists messages (
  id integer primary key,
  session_id text not null,
  role text not null,
  ts integer,
  text text not null
);
create index if not exists messages_session on messages(session_id, id);

create virtual table if not exists messages_fts using fts5(
  norm,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

create table if not exists links (
  session_id text not null,
  kind text not null,
  key text not null,
  url text,
  mentions integer not null default 0,
  first_at integer,
  source text not null,
  hidden integer not null default 0,
  primary key (session_id, kind, key)
);
create index if not exists links_key on links(kind, key);

create table if not exists key_prefixes (
  prefix text primary key,
  count integer not null
);

create table if not exists user_state (
  session_id text primary key,
  lifecycle text not null default 'active',
  note text,
  done_at integer,
  snoozed_until integer,
  updated_at integer not null
);

create table if not exists recaps (
  session_id text primary key,
  recap text not null,
  recap_at integer not null,
  message_count integer not null
);

create table if not exists todos (
  id integer primary key,
  title text not null,
  notes text,
  reported_day text not null,
  status text not null default 'todo',
  closed_day text,
  sort real not null,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists todos_status on todos(status, reported_day);

create table if not exists todo_links (
  todo_id integer not null references todos(id) on delete cascade,
  session_id text not null,
  origin text not null,
  created_at integer not null,
  primary key (todo_id, session_id)
);
create index if not exists todo_links_session on todo_links(session_id);

create table if not exists todo_rejections (
  todo_id integer not null references todos(id) on delete cascade,
  session_id text not null,
  primary key (todo_id, session_id)
);

create table if not exists todo_events (
  todo_id integer not null references todos(id) on delete cascade,
  day text not null,
  kind text not null,
  at integer not null
);
create index if not exists todo_events_day on todo_events(day);

create table if not exists thread_labels (
  session_id text primary key,
  label text not null,
  source text not null,
  updated_at integer not null
);

create table if not exists ask_batches (
  id integer primary key,
  prompt text not null,
  model text not null,
  status text not null,
  created_at integer not null
);

create table if not exists ask_items (
  batch_id integer not null references ask_batches(id) on delete cascade,
  session_id text not null,
  position integer not null,
  status text not null,
  answer text,
  error text,
  included integer not null default 1,
  started_at integer,
  finished_at integer,
  primary key (batch_id, session_id)
);

create table if not exists usage (
  day text not null,
  kind text not null,
  count integer not null,
  primary key (day, kind)
);

create table if not exists remote_status (
  kind text not null,
  key text not null,
  state text,
  category text,
  title text,
  url text,
  fetched_at integer not null,
  primary key (kind, key)
);
`;

export function openDb(dir: string): DB {
  const db = new Database(join(dir, 'index.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== SCHEMA_VERSION) {
    // Version 1 kept summaries inside `sessions`, so its derived tables must be rebuilt. Later
    // versions only add tables, which keeps user choices such as hidden links.
    if (version !== 0 && version < LAST_DESTRUCTIVE_VERSION) dropDerived(db);
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

export function dropDerived(db: DB): void {
  db.exec(`
    drop table if exists sessions;
    drop table if exists files;
    drop table if exists messages;
    drop table if exists messages_fts;
    drop table if exists links;
    drop table if exists key_prefixes;
  `);
}

/** Clears everything rebuilt from transcripts; keeps user_state, recaps and remote_status. */
export function resetIndex(db: DB): void {
  db.exec(`
    delete from messages_fts;
    delete from messages;
    delete from links where hidden = 0;
    delete from key_prefixes;
    delete from files;
    delete from sessions;
  `);
}
