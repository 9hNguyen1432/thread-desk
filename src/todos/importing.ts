import type { Card } from '../store.js';
import { todoKeys } from './matching.js';
import type { TodoService } from './service.js';

export interface ImportThread {
  id: string;
  title: string;
  column: Card['column'];
  projectName: string | null;
  lastAt: number | null;
}

export interface ImportGroup {
  key: string;
  title: string;
  ticket: string | null;
  threads: ImportThread[];
  suggested: boolean;
  /** An open todo already about this ticket; the threads join it instead of making a duplicate. */
  existingTodo: { id: number; title: string } | null;
}

const RECENT_MS = 3 * 86_400_000;
const CANDIDATE_MS = 14 * 86_400_000;

/**
 * Threads worth turning into todos: open in a terminal or touched in the last two weeks, not
 * finished, and not already part of an open todo. Threads sharing a ticket become one todo.
 */
export function importCandidates(cards: Card[], openTodoByTicket: Map<string, { id: number; title: string }> = new Map(), now = Date.now()): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const card of cards) {
    if (card.lifecycle === 'done' || card.lifecycle === 'archived' || card.continuedIn) continue;
    if (card.todos.length > 0) continue;
    const recent = (card.lastAt ?? 0) >= now - CANDIDATE_MS;
    if (!card.tab && !card.agent && !recent) continue;
    const key = card.primaryTicket ? `ticket:${card.primaryTicket}` : `thread:${card.id}`;
    const group = groups.get(key) ?? {
      key,
      title: card.primaryTicket && !card.title.includes(card.primaryTicket) ? `${card.primaryTicket} ${card.title}` : card.title,
      ticket: card.primaryTicket,
      threads: [],
      suggested: false,
      existingTodo: card.primaryTicket ? (openTodoByTicket.get(card.primaryTicket) ?? null) : null,
    };
    group.threads.push({ id: card.id, title: card.title, column: card.column, projectName: card.projectName, lastAt: card.lastAt });
    if ((card.lastAt ?? 0) >= now - RECENT_MS) group.suggested = true;
    groups.set(key, group);
  }
  const latest = (g: ImportGroup) => Math.max(...g.threads.map((t) => t.lastAt ?? 0));
  return [...groups.values()].sort((a, b) => Number(b.suggested) - Number(a.suggested) || latest(b) - latest(a));
}

/** Creates one todo per group and links its threads; todos with work today turn WIP on their own. */
export function importGroups(svc: TodoService, groups: { title: string; sessionIds: string[]; todoId?: number }[]): number[] {
  const ids: number[] = [];
  for (const g of groups) {
    const existing = g.todoId !== undefined ? svc.store.get(g.todoId) : null;
    const todo = existing && (existing.status === 'todo' || existing.status === 'wip') ? existing : svc.create(g.title);
    if (!todo) continue;
    for (const sessionId of g.sessionIds) svc.link(todo.id, sessionId, 'manual');
    ids.push(todo.id);
  }
  return ids;
}

/** Open todos by the ticket keys they mention, so imports can join them. */
export function openTodosByTicket(svc: TodoService, ticketRe: RegExp | null): Map<string, { id: number; title: string }> {
  const out = new Map<string, { id: number; title: string }>();
  for (const todo of svc.store.open()) {
    for (const k of todoKeys(todo, ticketRe)) if (k.kind === 'ticket' && !out.has(k.key)) out.set(k.key, { id: todo.id, title: todo.title });
  }
  return out;
}
