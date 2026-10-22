import { basename } from 'node:path';
import type { AgentKind } from './agents.js';
import type { DB } from './db.js';
import { closeBlocker, deriveColumn, isLive, liveStatus, type Column, type Lifecycle } from './board.js';
import type { LinkKind, LinkSource } from './links.js';
import { SOURCE_PRIORITY } from './links.js';
import type { LiveSnapshot } from './live/state.js';
import type { HookState } from './board.js';
import type { ThreadLabel } from './labels.js';
import type { LiveStatus, Tab } from './terminal/types.js';
import { displayTitle } from './transcript/parse.js';
import type { SessionRow } from './transcript/indexer.js';

export interface LinkView {
  kind: LinkKind;
  key: string;
  url: string | null;
  mentions: number;
  source: LinkSource;
  state: string | null;
  category: string | null;
  title: string | null;
}

export interface Recap {
  goal: string;
  done: string;
  next: string;
  blocker: string;
}

export interface Card {
  id: string;
  /** Which coding agent this session belongs to. */
  agentKind: AgentKind;
  title: string;
  cwd: string | null;
  project: string | null;
  projectName: string | null;
  branch: string | null;
  firstAt: number | null;
  lastAt: number | null;
  lastHumanAt: number | null;
  lastAssistantAt: number | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  humanCount: number;
  messageCount: number;
  lifecycle: Lifecycle;
  note: string | null;
  doneAt: number | null;
  snoozedUntil: number | null;
  column: Column;
  live: LiveStatus | null;
  agent: { kind: string; pid: number | null; status: string | null; state: string | null; waitingFor: string | null } | null;
  tab: { ref: string; windowRef: string; title: string; memoryBytes: number } | null;
  /** Why the tab cannot be closed from Thread Desk right now; null when closing is safe. */
  closeBlock: string | null;
  /** Open todos this thread is linked to. */
  todos: { id: number; title: string }[];
  label: ThreadLabel | null;
  links: LinkView[];
  mentioned: LinkView[];
  primaryTicket: string | null;
  recap: Recap | null;
  recapAt: number | null;
  transcriptExists: boolean;
  continuedIn: string | null;
  claudeVersion: string | null;
}

interface Row extends SessionRow {
  recap: string | null;
  recap_at: number | null;
  lifecycle: Lifecycle | null;
  note: string | null;
  done_at: number | null;
  snoozed_until: number | null;
}

interface LinkRow {
  session_id: string;
  kind: LinkKind;
  key: string;
  url: string | null;
  mentions: number;
  source: LinkSource;
  state: string | null;
  category: string | null;
  title: string | null;
}

export interface SessionFilter {
  project?: string;
  includeContinued?: boolean;
  ids?: string[];
}

const PRIMARY_SOURCES: ReadonlySet<LinkSource> = new Set(['pr-link', 'branch', 'title', 'user']);

export function parseRecap(raw: string | null): Recap | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Recap>;
    return { goal: v.goal ?? '', done: v.done ?? '', next: v.next ?? '', blocker: v.blocker ?? '' };
  } catch {
    return null;
  }
}

export class Store {
  constructor(private readonly db: DB) {}

  private rows(filter: SessionFilter): Row[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeContinued) where.push('s.continued_in is null');
    if (filter.project) {
      where.push('s.project = ?');
      params.push(filter.project);
    }
    if (filter.ids) {
      if (filter.ids.length === 0) return [];
      where.push(`s.id in (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    const sql = `
      select s.*, u.lifecycle, u.note, u.done_at, u.snoozed_until, r.recap, r.recap_at
      from sessions s left join user_state u on u.session_id = s.id left join recaps r on r.session_id = s.id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by coalesce(s.last_at, 0) desc`;
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private linksFor(ids: string[]): Map<string, LinkRow[]> {
    const out = new Map<string, LinkRow[]>();
    if (ids.length === 0) return out;
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const rows = this.db
        .prepare(
          `select l.session_id, l.kind, l.key, l.url, l.mentions, l.source, r.state, r.category, r.title
           from links l left join remote_status r on r.kind = l.kind and r.key = l.key
           where l.hidden = 0 and l.session_id in (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as LinkRow[];
      for (const row of rows) {
        const list = out.get(row.session_id) ?? [];
        list.push(row);
        out.set(row.session_id, list);
      }
    }
    return out;
  }

  cards(filter: SessionFilter, live: LiveSnapshot, hooks: Map<string, HookState>): Card[] {
    const rows = this.rows(filter);
    const links = this.linksFor(rows.map((r) => r.id));
    return rows.map((row) => toCard(row, links.get(row.id) ?? [], live, hooks.get(row.id)));
  }

  card(id: string, live: LiveSnapshot, hooks: Map<string, HookState>): Card | null {
    return this.cards({ ids: [id], includeContinued: true }, live, hooks)[0] ?? null;
  }

  session(id: string): SessionRow | null {
    return (this.db.prepare('select * from sessions where id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  /**
   * For agents that cannot say which session a process runs: the most recently active session of
   * that agent in the tab's folder since the process started, skipping sessions already matched.
   */
  guessSession(tab: Tab, taken: ReadonlySet<string>): string | null {
    if (!tab.agentKind || !tab.cwd) return null;
    const since = tab.agentStartedAt !== null ? tab.agentStartedAt - 60_000 : 0;
    const rows = this.db
      .prepare(
        `select id from sessions where agent = ? and cwd = ? and coalesce(last_at, first_at, 0) >= ?
         order by coalesce(last_at, first_at, 0) desc limit 10`,
      )
      .all(tab.agentKind, tab.cwd, since) as { id: string }[];
    return rows.find((r) => !taken.has(r.id))?.id ?? null;
  }

  /** Follows `continued-in` records to the newest session of a thread. */
  latestInChain(id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const next = this.session(current)?.continued_in;
      if (!next || !this.session(next)) break;
      current = next;
    }
    return current;
  }

  projects(): { project: string; name: string; count: number }[] {
    const rows = this.db
      .prepare(
        `select project, count(*) as count from sessions
         where project is not null and continued_in is null group by project order by count desc`,
      )
      .all() as { project: string; count: number }[];
    return rows.map((r) => ({ project: r.project, name: basename(r.project), count: r.count }));
  }

  agentCounts(): { kind: AgentKind; count: number }[] {
    return this.db
      .prepare('select agent as kind, count(*) as count from sessions where continued_in is null group by agent order by count desc')
      .all() as { kind: AgentKind; count: number }[];
  }

  messages(id: string, limit: number): { role: string; ts: number | null; text: string }[] {
    const rows = this.db
      .prepare('select role, ts, text from messages where session_id = ? order by id desc limit ?')
      .all(id, limit) as { role: string; ts: number | null; text: string }[];
    return rows.reverse();
  }

  lifecycleOf(id: string): { lifecycle: Lifecycle; note: string | null } {
    const row = this.db.prepare('select lifecycle, note from user_state where session_id = ?').get(id) as
      | { lifecycle: Lifecycle; note: string | null }
      | undefined;
    return row ?? { lifecycle: 'active', note: null };
  }

  setLifecycle(id: string, lifecycle: Lifecycle): void {
    const now = Date.now();
    this.db
      .prepare(
        `insert into user_state (session_id, lifecycle, done_at, updated_at) values (?, ?, ?, ?)
         on conflict(session_id) do update set lifecycle = excluded.lifecycle, done_at = excluded.done_at,
           updated_at = excluded.updated_at`,
      )
      .run(id, lifecycle, lifecycle === 'done' ? now : null, now);
  }

  setNote(id: string, note: string | null): void {
    this.db
      .prepare(
        `insert into user_state (session_id, note, updated_at) values (?, ?, ?)
         on conflict(session_id) do update set note = excluded.note`,
      )
      .run(id, note, Date.now());
  }

  snooze(id: string, until: number | null): void {
    this.db
      .prepare(
        `insert into user_state (session_id, snoozed_until, updated_at) values (?, ?, ?)
         on conflict(session_id) do update set snoozed_until = excluded.snoozed_until`,
      )
      .run(id, until, Date.now());
  }

  hideLink(id: string, kind: string, key: string): void {
    this.db.prepare('update links set hidden = 1 where session_id = ? and kind = ? and key = ?').run(id, kind, key);
  }

  setRecap(id: string, recap: Recap, messageCount: number): void {
    this.db
      .prepare(
        `insert into recaps (session_id, recap, recap_at, message_count) values (?, ?, ?, ?)
         on conflict(session_id) do update set recap = excluded.recap, recap_at = excluded.recap_at,
           message_count = excluded.message_count`,
      )
      .run(id, JSON.stringify(recap), Date.now(), messageCount);
  }

  recapMessageCount(id: string): number {
    const row = this.db.prepare('select message_count from recaps where session_id = ?').get(id) as { message_count: number } | undefined;
    return row?.message_count ?? 0;
  }

  ticketPrefixSuggestions(exclude: string[]): { prefix: string; count: number }[] {
    const skip = new Set(exclude.map((k) => k.toUpperCase()));
    const rows = this.db
      .prepare('select prefix, count from key_prefixes where count >= 3 order by count desc limit 20')
      .all() as { prefix: string; count: number }[];
    return rows.filter((r) => !skip.has(r.prefix));
  }
}

function toLinkView(r: LinkRow): LinkView {
  return {
    kind: r.kind,
    key: r.key,
    url: r.url,
    mentions: r.mentions,
    source: r.source,
    state: r.state,
    category: r.category,
    title: r.title,
  };
}

export function primaryTicket(links: LinkView[]): string | null {
  const tickets = links.filter((l) => l.kind === 'ticket' && PRIMARY_SOURCES.has(l.source));
  tickets.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || b.mentions - a.mentions);
  return tickets[0]?.key ?? null;
}

function toCard(row: Row, linkRows: LinkRow[], live: LiveSnapshot, hook: HookState | undefined): Card {
  const agent = live.agents.get(row.id);
  const tab = live.tabBySession.get(row.id);
  const status = liveStatus(agent, tab, hook);
  const lifecycle = row.lifecycle ?? 'active';
  const all = linkRows.map(toLinkView);
  const primary = all.filter((l) => PRIMARY_SOURCES.has(l.source));
  primary.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || b.mentions - a.mentions);
  const mentioned = all.filter((l) => !PRIMARY_SOURCES.has(l.source)).sort((a, b) => b.mentions - a.mentions);
  return {
    id: row.id,
    agentKind: row.agent,
    title: displayTitle(row),
    cwd: row.cwd,
    project: row.project,
    projectName: row.project ? basename(row.project) : null,
    branch: row.git_branch,
    firstAt: row.first_at,
    lastAt: row.last_at,
    lastHumanAt: row.last_human_at,
    lastAssistantAt: row.last_assistant_at,
    // Only the start is needed (labels, display); pasted logs can be huge.
    firstPrompt: row.first_prompt ? row.first_prompt.slice(0, 2000) : null,
    lastPrompt: row.last_prompt,
    lastAssistant: hook?.lastAssistantMessage ?? row.last_assistant,
    humanCount: row.human_count,
    messageCount: row.message_count,
    lifecycle,
    note: row.note,
    doneAt: row.done_at,
    snoozedUntil: row.snoozed_until,
    column: deriveColumn(lifecycle, status),
    live: status,
    agent: agent && isLive(agent, tab)
      ? { kind: agent.kind, pid: agent.pid, status: agent.status, state: agent.state, waitingFor: agent.waitingFor }
      : null,
    tab: tab ? { ref: tab.ref, windowRef: tab.windowRef, title: tab.title, memoryBytes: tab.memoryBytes } : null,
    closeBlock: tab ? closeBlocker(agent, tab, status, live.errors, row.last_at, Date.now(), live.guessedTabs.has(tab.ref)) : null,
    todos: [],
    label: null,
    links: primary,
    mentioned,
    primaryTicket: primaryTicket(primary),
    recap: parseRecap(row.recap),
    recapAt: row.recap_at,
    transcriptExists: row.transcript_exists === 1,
    continuedIn: row.continued_in,
    claudeVersion: row.claude_version,
  };
}
