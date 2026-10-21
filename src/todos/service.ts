import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { LinkRef } from '../links.js';
import type { Searcher } from '../search.js';
import type { Card } from '../store.js';
import { activityBetween, type SessionActivity } from './activity.js';
import { dayOf, dayRange, daysBetween, type Day } from './day.js';
import { closedDayAsOf, lastStatusChange, statusOnDay, visibleOn, type StatusEvent } from './history.js';
import { AUTO_LINK_KINDS, promptFingerprint, sessionsSharingKeys, suggestThreads, todoKeys } from './matching.js';
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
/** A launched thread's first message can be stamped slightly before the launch is recorded. */
const LAUNCH_CLOCK_SKEW_MS = 60_000;
const SUGGEST_CACHE_MS = 2 * 60_000;

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
  private suggestionCache = new Map<number, { key: string; at: number; value: TodoView['suggestions'] }>();

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

  private eventsByTodo(ids: number[]): Map<number, StatusEvent[]> {
    const events = new Map<number, StatusEvent[]>();
    for (const e of this.store.events(ids)) events.set(e.todo_id, [...(events.get(e.todo_id) ?? []), e]);
    return events;
  }

  private doneHint(threads: TodoThread[], cardById: Map<string, Card>): string | null {
    if (threads.length === 0) return null;
    const cards = threads.map((t) => cardById.get(t.id)).filter((c): c is Card => Boolean(c));
    if (cards.length > 0 && cards.every((c) => c.lifecycle === 'done' || c.lifecycle === 'archived')) return 'All linked threads are done';
    const prs = cards.flatMap((c) => c.links.filter((l) => l.kind === 'pr' && l.source === 'pr-link'));
    if (prs.length > 0 && prs.every((p) => p.state === 'MERGED')) return prs.length === 1 ? 'Its PR is merged' : 'All its PRs are merged';
    const tickets = cards.map((c) => c.links.find((l) => l.kind === 'ticket' && l.key === c.primaryTicket)).filter(Boolean);
    if (tickets.length > 0 && tickets.every((t) => t!.category === 'done')) return 'Its ticket is done';
    return null;
  }

  /** Suggestions run several full-text searches, so they are cached until the todo or its links change. */
  private suggestionsFor(todo: TodoRow, keys: LinkRef[], linked: string[], cards: Card[]): TodoView['suggestions'] {
    const rejected = this.store.rejected(todo.id);
    const cacheKey = `${todo.updated_at}|${linked.join(',')}|${[...rejected].join(',')}`;
    const hit = this.suggestionCache.get(todo.id);
    if (hit && hit.key === cacheKey && Date.now() - hit.at < SUGGEST_CACHE_MS) return hit.value;
    const titles = new Map(cards.map((c) => [c.id, c.title]));
    const projects = new Map(cards.map((c) => [c.id, c.projectName]));
    const value = suggestThreads(this.deps.db, this.deps.searcher, {
      todo,
      keys,
      exclude: new Set([...linked, ...rejected]),
      titles,
      recentSince: Date.now() - SUGGEST_WINDOW_MS,
      lastAt: new Map(cards.map((c) => [c.id, c.lastAt ?? 0])),
    }).map((sg) => ({ sessionId: sg.sessionId, title: titles.get(sg.sessionId) ?? sg.sessionId, projectName: projects.get(sg.sessionId) ?? null, reason: sg.reason }));
    this.suggestionCache.set(todo.id, { key: cacheKey, at: Date.now(), value });
    return value;
  }

  /**
   * Todos as they stood on `day`. Status comes from history, and a thread's time that day is split
   * between the todos of that day it is linked to, so nothing is counted twice or lost.
   */
  view(day: Day, opts: { suggest?: boolean; cards?: Card[] } = {}): TodoView[] {
    const candidates = this.store.reportedBy(day);
    const events = this.eventsByTodo(candidates.map((t) => t.id));
    const todos = candidates.filter((t) => visibleOn(t.reported_day, events.get(t.id) ?? [], day));
    const links = this.store.links(todos.map((t) => t.id));
    const cards = opts.cards ?? this.deps.cards();
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const activity = this.activityOn(day);
    const shares = new Map<string, number>();
    for (const l of links) shares.set(l.session_id, (shares.get(l.session_id) ?? 0) + 1);
    const suggest = opts.suggest === true && day === this.today();
    const ticketRe = this.deps.ticketRe();

    const views = todos.map((todo) => {
      const own = links.filter((l) => l.todo_id === todo.id);
      const threads: TodoThread[] = own.map((l) => {
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
      const history = events.get(todo.id) ?? [];
      const status = statusOnDay(history, day);
      const open = status === 'todo' || status === 'wip';
      const keys = todoKeys(todo, ticketRe);
      return {
        id: todo.id,
        title: todo.title,
        notes: todo.notes,
        status,
        reportedDay: todo.reported_day,
        closedDay: closedDayAsOf(history, day),
        carriedDays: open ? daysBetween(todo.reported_day, day) : 0,
        keys,
        threads,
        minutes: threads.reduce((sum, t) => sum + t.minutes, 0),
        suggestions: open && suggest ? this.suggestionsFor(todo, keys, own.map((l) => l.session_id), cards) : [],
        doneHint: open ? this.doneHint(threads, cardById) : null,
      };
    });
    const closedLast = (v: TodoView) => (v.status === 'done' || v.status === 'dropped' ? 1 : 0);
    return views.sort((a, b) => closedLast(a) - closedLast(b));
  }

  /** Links new threads to todos: by launch (exact) or by an identical link the user mentioned. */
  onSessionsChanged(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const open = this.store.open();
    if (open.length === 0) return;
    const ticketRe = this.deps.ticketRe();
    const wanted = new Set(sessionIds);
    // Work out once per call which sessions each todo could auto-link, instead of per session.
    const autoCandidates = new Map<number, Set<string>>();
    for (const todo of open) {
      const keys = todoKeys(todo, ticketRe).filter((k) => AUTO_LINK_KINDS.has(k.kind));
      if (keys.length === 0) continue;
      const rejected = this.store.rejected(todo.id);
      const ids = sessionsSharingKeys(this.deps.db, keys)
        .filter((m) => m.autoEligible && wanted.has(m.sessionId) && !rejected.has(m.sessionId))
        .map((m) => m.sessionId);
      if (ids.length) autoCandidates.set(todo.id, new Set(ids));
    }
    const touched: number[] = [];
    let changed = false;
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < LAUNCH_WINDOW_MS);

    for (const sessionId of sessionIds) {
      const s = this.deps.db.prepare('select id, cwd, first_prompt, first_at from sessions where id = ?').get(sessionId) as
        | { id: string; cwd: string | null; first_prompt: string | null; first_at: number | null }
        | undefined;
      if (!s) continue;

      if (s.first_prompt && s.cwd && s.first_at) {
        const fp = promptFingerprint(s.first_prompt);
        const launch = [...this.pending]
          .reverse()
          .find((p) => p.cwd === s.cwd && s.first_at! >= p.at - LAUNCH_CLOCK_SKEW_MS && (fp === p.fingerprint || (p.fingerprint.length >= 40 && fp.startsWith(p.fingerprint))));
        if (launch && this.store.link(launch.todoId, s.id, 'started')) {
          this.pending = this.pending.filter((p) => p !== launch);
          touched.push(launch.todoId);
          changed = true;
        }
      }

      for (const todo of open) {
        if (!autoCandidates.get(todo.id)?.has(s.id)) continue;
        if ((s.first_at ?? 0) < todo.created_at - AUTO_LINK_GRACE_MS) continue;
        if (this.store.link(todo.id, s.id, 'auto')) {
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

  /**
   * A todo becomes WIP when one of its threads gets a prompt since the todo existed (or since the
   * start of the day it was written) and after its latest status change, so moving a todo back to
   * "To do" by hand sticks until new work happens.
   */
  private promoteToWip(todoIds: number[]): boolean {
    let changed = false;
    const ids = [...new Set(todoIds)];
    const events = this.eventsByTodo(ids);
    // Work earlier today counts too: writing the todo after starting the thread is common.
    const dayStart = dayRange(this.today(), this.dayCfg.startHour).start;
    for (const id of ids) {
      const todo = this.store.get(id);
      if (!todo || todo.status !== 'todo') continue;
      const row = this.deps.db
        .prepare(
          `select max(s.last_human_at) as at from todo_links l join sessions s on s.id = l.session_id
           where l.todo_id = ? and s.last_human_at >= ? and s.last_human_at > ?`,
        )
        .get(id, Math.min(todo.created_at, dayStart), lastStatusChange(events.get(id) ?? [])) as { at: number | null };
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
