import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { LinkRef } from '../links.js';
import type { Searcher } from '../search.js';
import type { Card } from '../store.js';
import { activityBetween, type SessionActivity } from './activity.js';
import { dayOf, dayRange, daysBetween, type Day } from './day.js';
import { promptFingerprint, sessionsSharingKeys, suggestThreads, todoKeys } from './matching.js';
import { TodoStore, type LinkOrigin, type TodoRow, type TodoStatus } from './store.js';

export interface TodoThread {
  id: string;
  title: string;
  column: Card['column'];
  lifecycle: Card['lifecycle'];
  projectName: string | null;
  origin: LinkOrigin;
  minutes: number;
}

export interface TodoView {
  id: number;
  title: string;
  notes: string | null;
  status: TodoStatus;
  reportedDay: Day;
  closedDay: Day | null;
  carriedDays: number;
  keys: LinkRef[];
  threads: TodoThread[];
  minutes: number;
  suggestions: { sessionId: string; title: string; projectName: string | null; reason: string }[];
  doneHint: string | null;
}

export interface TodoDeps {
  db: DB;
  config: () => Config;
  searcher: Searcher;
  ticketRe: () => RegExp | null;
  cards: () => Card[];
  changed: () => void;
}

interface PendingLaunch {
  todoId: number;
  cwd: string;
  fingerprint: string;
  at: number;
}

const SUGGEST_WINDOW_MS = 30 * 86_400_000;
const LAUNCH_WINDOW_MS = 15 * 60_000;
/** Auto-linking is only for threads that start after the todo, so old threads stay suggestions. */
const AUTO_LINK_GRACE_MS = 10 * 60_000;

export function splitTodoText(text: string): { title: string; notes: string | null } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first === -1) return { title: '', notes: null };
  const title = lines[first]!.trim().slice(0, 200);
  const notes = lines.slice(first + 1).join('\n').trim();
  return { title, notes: notes || null };
}

export class TodoService {
  readonly store: TodoStore;
  private pending: PendingLaunch[] = [];

  constructor(private readonly deps: TodoDeps) {
    this.store = new TodoStore(deps.db);
  }

  private get dayCfg() {
    return this.deps.config().day;
  }

  cards(): Card[] {
    return this.deps.cards();
  }

  today(now = Date.now()): Day {
    return dayOf(now, this.dayCfg.startHour);
  }

  create(text: string): TodoRow | null {
    const { title, notes } = splitTodoText(text);
    if (!title) return null;
    const todo = this.store.create(title, notes, this.today());
    this.deps.changed();
    return todo;
  }

  setStatus(id: number, status: TodoStatus): void {
    this.store.setStatus(id, status, this.today());
    this.deps.changed();
  }

  link(todoId: number, sessionId: string, origin: LinkOrigin): void {
    if (this.store.link(todoId, sessionId, origin)) this.promoteToWip([todoId]);
    this.deps.changed();
  }

  registerLaunch(todoId: number, cwd: string, prompt: string): void {
    const now = Date.now();
    this.pending = [...this.pending.filter((p) => now - p.at < LAUNCH_WINDOW_MS), { todoId, cwd, fingerprint: promptFingerprint(prompt), at: now }];
  }

  activityOn(day: Day): Map<string, SessionActivity> {
    const { start, end } = dayRange(day, this.dayCfg.startHour);
    return activityBetween(this.deps.db, start, end, this.dayCfg.idleGapMinutes);
  }

  /** How many todos each thread is linked to, so its time is split instead of counted twice. */
  private shares(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const l of this.store.allLinks()) counts.set(l.session_id, (counts.get(l.session_id) ?? 0) + 1);
    return counts;
  }

  private statusOn(todo: TodoRow, day: Day, threadsActive: boolean, events: Map<number, { day: Day; kind: string }[]>): TodoStatus {
    if (todo.closed_day && todo.closed_day <= day) return todo.status;
    if (threadsActive) return 'wip';
    const past = (events.get(todo.id) ?? []).filter((e) => e.day <= day && e.kind !== 'created');
    const last = past[past.length - 1];
    return last?.kind === 'wip' ? 'wip' : 'todo';
  }

  private doneHint(threads: TodoThread[], cardById: Map<string, Card>): string | null {
    if (threads.length === 0) return null;
    const cards = threads.map((t) => cardById.get(t.id)).filter((c): c is Card => Boolean(c));
    if (cards.length > 0 && cards.every((c) => c.lifecycle === 'done' || c.lifecycle === 'archived')) return 'All linked threads are done';
    const prs = cards.flatMap((c) => c.links.filter((l) => l.kind === 'pr' && l.source === 'pr-link'));
    if (prs.length > 0 && prs.every((p) => p.category === 'done')) return prs.length === 1 ? 'Its PR is merged' : 'All its PRs are merged';
    const tickets = cards.map((c) => c.links.find((l) => l.kind === 'ticket' && l.key === c.primaryTicket)).filter(Boolean);
    if (tickets.length > 0 && tickets.every((t) => t!.category === 'done')) return 'Its ticket is done';
    return null;
  }

  view(day: Day): TodoView[] {
    const todos = this.store.forDay(day);
    const ids = todos.map((t) => t.id);
    const links = this.store.links(ids);
    const events = new Map<number, { day: Day; kind: string }[]>();
    for (const e of this.store.events(ids)) events.set(e.todo_id, [...(events.get(e.todo_id) ?? []), e]);
    const cards = this.deps.cards();
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const activity = this.activityOn(day);
    const shares = this.shares();
    const isToday = day === this.today();
    const titles = new Map(cards.map((c) => [c.id, c.title]));
    const lastAt = new Map(cards.map((c) => [c.id, c.lastAt ?? 0]));
    const ticketRe = this.deps.ticketRe();

    return todos.map((todo) => {
      const threads: TodoThread[] = links
        .filter((l) => l.todo_id === todo.id)
        .map((l) => {
          const card = cardById.get(l.session_id);
          const a = activity.get(l.session_id);
          return {
            id: l.session_id,
            title: card?.title ?? 'Thread no longer indexed',
            column: card?.column ?? 'paused',
            lifecycle: card?.lifecycle ?? 'active',
            projectName: card?.projectName ?? null,
            origin: l.origin,
            minutes: a ? a.minutes / (shares.get(l.session_id) ?? 1) : 0,
          };
        });
      const active = links.some((l) => l.todo_id === todo.id && (activity.get(l.session_id)?.humanMessages ?? 0) > 0);
      const status = this.statusOn(todo, day, active, events);
      const open = status === 'todo' || status === 'wip';
      const keys = todoKeys(todo, ticketRe);
      let suggestions: TodoView['suggestions'] = [];
      if (open && isToday) {
        const exclude = new Set([...threads.map((t) => t.id), ...this.store.rejected(todo.id)]);
        suggestions = suggestThreads(this.deps.db, this.deps.searcher, {
          todo,
          keys,
          exclude,
          titles,
          recentSince: Date.now() - SUGGEST_WINDOW_MS,
          lastAt,
        }).map((s) => ({
          sessionId: s.sessionId,
          title: titles.get(s.sessionId) ?? s.sessionId,
          projectName: cardById.get(s.sessionId)?.projectName ?? null,
          reason: s.reason,
        }));
      }
      return {
        id: todo.id,
        title: todo.title,
        notes: todo.notes,
        status,
        reportedDay: todo.reported_day,
        closedDay: todo.closed_day,
        carriedDays: open ? daysBetween(todo.reported_day, day) : 0,
        keys,
        threads,
        minutes: threads.reduce((sum, t) => sum + t.minutes, 0),
        suggestions,
        doneHint: open ? this.doneHint(threads, cardById) : null,
      };
    });
  }

  /** Links new threads to todos: by launch (exact) or by an identical link the user mentioned. */
  onSessionsChanged(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const open = this.store.open();
    if (open.length === 0) return;
    const ticketRe = this.deps.ticketRe();
    const keysByTodo = new Map(open.map((t) => [t.id, todoKeys(t, ticketRe)]));
    const touched: number[] = [];
    let changed = false;

    for (const sessionId of sessionIds) {
      const s = this.deps.db
        .prepare('select id, cwd, first_prompt, first_at, last_human_at from sessions where id = ?')
        .get(sessionId) as { id: string; cwd: string | null; first_prompt: string | null; first_at: number | null; last_human_at: number | null } | undefined;
      if (!s) continue;

      const now = Date.now();
      if (s.first_prompt && s.cwd) {
        const fp = promptFingerprint(s.first_prompt);
        const launch = this.pending.find((p) => p.cwd === s.cwd && now - p.at < LAUNCH_WINDOW_MS && (fp.startsWith(p.fingerprint) || p.fingerprint.startsWith(fp)));
        if (launch && this.store.link(launch.todoId, s.id, 'started')) {
          this.pending = this.pending.filter((p) => p !== launch);
          touched.push(launch.todoId);
          changed = true;
        }
      }

      for (const todo of open) {
        const keys = keysByTodo.get(todo.id) ?? [];
        if (keys.length === 0 || (s.first_at ?? 0) < todo.created_at - AUTO_LINK_GRACE_MS) continue;
        const shared = sessionsSharingKeys(this.deps.db, keys).some((m) => m.sessionId === s.id && m.fromUser);
        if (shared && !this.store.rejected(todo.id).has(s.id) && this.store.link(todo.id, s.id, 'auto')) {
          touched.push(todo.id);
          changed = true;
        }
      }
    }

    const linkedTodos = this.deps.db
      .prepare(`select distinct todo_id from todo_links where session_id in (${sessionIds.map(() => '?').join(',')})`)
      .all(...sessionIds) as { todo_id: number }[];
    if (this.promoteToWip([...touched, ...linkedTodos.map((r) => r.todo_id)])) changed = true;
    if (changed) this.deps.changed();
  }

  /** A todo becomes WIP once one of its threads gets a prompt from the user after the todo existed. */
  private promoteToWip(todoIds: number[]): boolean {
    let changed = false;
    for (const id of new Set(todoIds)) {
      const todo = this.store.get(id);
      if (!todo || todo.status !== 'todo') continue;
      const row = this.deps.db
        .prepare(
          `select max(s.last_human_at) as at from todo_links l join sessions s on s.id = l.session_id
           where l.todo_id = ? and s.last_human_at >= ?`,
        )
        .get(id, todo.created_at) as { at: number | null };
      if (row.at) {
        this.store.setStatus(id, 'wip', dayOf(row.at, this.dayCfg.startHour));
        changed = true;
      }
    }
    return changed;
  }

  /** Open todos per thread, for chips on the board. */
  todosBySession(): Map<string, { id: number; title: string }[]> {
    const open = new Map(this.store.open().map((t) => [t.id, t]));
    const out = new Map<string, { id: number; title: string }[]>();
    for (const l of this.store.allLinks()) {
      const todo = open.get(l.todo_id);
      if (!todo) continue;
      out.set(l.session_id, [...(out.get(l.session_id) ?? []), { id: todo.id, title: todo.title }]);
    }
    return out;
  }
}
