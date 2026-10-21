import type { Day } from './day.js';
import type { TodoStatus } from './store.js';

export interface StatusEvent {
  day: Day;
  kind: string;
  at: number;
}

const STATUS_KINDS: ReadonlySet<string> = new Set(['todo', 'wip', 'done', 'dropped']);

function isClosed(status: TodoStatus): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * The status a todo had at the end of `day`, read from its history so that reopening or
 * closing a todo later never rewrites what earlier days looked like.
 */
export function statusOnDay(events: StatusEvent[], day: Day): TodoStatus {
  let status: TodoStatus = 'todo';
  let at = -Infinity;
  for (const e of events) {
    if (e.day <= day && STATUS_KINDS.has(e.kind) && e.at >= at) {
      status = e.kind as TodoStatus;
      at = e.at;
    }
  }
  return status;
}

/** True when the todo ended `day` closed and was closed on that very day. */
export function closedOn(events: StatusEvent[], day: Day): boolean {
  return isClosed(statusOnDay(events, day)) && events.some((e) => e.day === day && (e.kind === 'done' || e.kind === 'dropped'));
}

/** The day the todo was last closed, as seen from `day`; null while it is open. */
export function closedDayAsOf(events: StatusEvent[], day: Day): Day | null {
  if (!isClosed(statusOnDay(events, day))) return null;
  let last: StatusEvent | null = null;
  for (const e of events) if (e.day <= day && (e.kind === 'done' || e.kind === 'dropped') && (!last || e.at >= last.at)) last = e;
  return last?.day ?? null;
}

/** A todo shows on a day from its reported day on, while open, and on the day it was closed. */
export function visibleOn(reportedDay: Day, events: StatusEvent[], day: Day): boolean {
  if (reportedDay > day) return false;
  return !isClosed(statusOnDay(events, day)) || closedOn(events, day);
}

/** When the status last changed, so automatic WIP never overrides a newer manual change. */
export function lastStatusChange(events: StatusEvent[]): number {
  let at = 0;
  for (const e of events) if (STATUS_KINDS.has(e.kind) && e.at > at) at = e.at;
  return at;
}
