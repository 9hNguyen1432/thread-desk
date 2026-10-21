import type { DB } from '../db.js';
import type { Day } from './day.js';

export type TodoStatus = 'todo' | 'wip' | 'done' | 'dropped';
export type LinkOrigin = 'auto' | 'accepted' | 'manual' | 'started';

export const TODO_STATUSES: readonly TodoStatus[] = ['todo', 'wip', 'done', 'dropped'];

export interface TodoRow {
  id: number;
  title: string;
  notes: string | null;
  reported_day: Day;
  status: TodoStatus;
  /** Day the todo was done or dropped. */
  closed_day: Day | null;
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface TodoLinkRow {
  todo_id: number;
  session_id: string;
  origin: LinkOrigin;
  created_at: number;
}

export interface TodoEventRow {
  todo_id: number;
  day: Day;
  kind: TodoStatus | 'created';
  at: number;
}

export class TodoStore {
  constructor(private readonly db: DB) {}

  get(id: number): TodoRow | null {
    return (this.db.prepare('select * from todos where id = ?').get(id) as TodoRow | undefined) ?? null;
  }

  create(title: string, notes: string | null, day: Day): TodoRow {
    const now = Date.now();
    const sort = (this.db.prepare('select coalesce(max(sort), 0) + 1 as next from todos').get() as { next: number }).next;
    const { lastInsertRowid } = this.db
      .prepare('insert into todos (title, notes, reported_day, status, sort, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(title, notes, day, 'todo', sort, now, now);
    const id = Number(lastInsertRowid);
    this.event(id, day, 'created');
    return this.get(id)!;
  }

  update(id: number, fields: { title?: string; notes?: string | null }): void {
    const todo = this.get(id);
    if (!todo) return;
    this.db
      .prepare('update todos set title = ?, notes = ?, updated_at = ? where id = ?')
      .run(fields.title ?? todo.title, fields.notes === undefined ? todo.notes : fields.notes, Date.now(), id);
  }

  setStatus(id: number, status: TodoStatus, day: Day): void {
    const closed = status === 'done' || status === 'dropped' ? day : null;
    this.db.prepare('update todos set status = ?, closed_day = ?, updated_at = ? where id = ?').run(status, closed, Date.now(), id);
    this.event(id, day, status);
  }

  remove(id: number): void {
    this.db.prepare('delete from todos where id = ?').run(id);
  }

  reorder(ids: number[]): void {
    const update = this.db.prepare('update todos set sort = ? where id = ?');
    this.db.transaction(() => ids.forEach((id, i) => update.run(i + 1, id)))();
  }

  /** Todos that existed and were not yet closed on `day`, plus those closed that day. */
  forDay(day: Day): TodoRow[] {
    return this.db
      .prepare(
        `select * from todos where reported_day <= ? and (closed_day is null or closed_day >= ?)
         order by case when closed_day is not null and closed_day <= ? then 1 else 0 end, sort`,
      )
      .all(day, day, day) as TodoRow[];
  }

  open(): TodoRow[] {
    return this.db.prepare("select * from todos where status in ('todo', 'wip') order by sort").all() as TodoRow[];
  }

  private event(todoId: number, day: Day, kind: TodoEventRow['kind']): void {
    this.db.prepare('insert into todo_events (todo_id, day, kind, at) values (?, ?, ?, ?)').run(todoId, day, kind, Date.now());
  }

  events(todoIds: number[]): TodoEventRow[] {
    if (todoIds.length === 0) return [];
    return this.db
      .prepare(`select * from todo_events where todo_id in (${todoIds.map(() => '?').join(',')}) order by at`)
      .all(...todoIds) as TodoEventRow[];
  }

  eventsOnDay(day: Day): TodoEventRow[] {
    return this.db.prepare('select * from todo_events where day = ? order by at').all(day) as TodoEventRow[];
  }

  links(todoIds: number[]): TodoLinkRow[] {
    if (todoIds.length === 0) return [];
    return this.db
      .prepare(`select * from todo_links where todo_id in (${todoIds.map(() => '?').join(',')}) order by created_at`)
      .all(...todoIds) as TodoLinkRow[];
  }

  allLinks(): TodoLinkRow[] {
    return this.db.prepare('select * from todo_links').all() as TodoLinkRow[];
  }

  link(todoId: number, sessionId: string, origin: LinkOrigin): boolean {
    const res = this.db
      .prepare('insert or ignore into todo_links (todo_id, session_id, origin, created_at) values (?, ?, ?, ?)')
      .run(todoId, sessionId, origin, Date.now());
    if (res.changes > 0) this.db.prepare('delete from todo_rejections where todo_id = ? and session_id = ?').run(todoId, sessionId);
    return res.changes > 0;
  }

  unlink(todoId: number, sessionId: string): void {
    this.db.prepare('delete from todo_links where todo_id = ? and session_id = ?').run(todoId, sessionId);
  }

  reject(todoId: number, sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare('delete from todo_links where todo_id = ? and session_id = ?').run(todoId, sessionId);
      this.db.prepare('insert or ignore into todo_rejections (todo_id, session_id) values (?, ?)').run(todoId, sessionId);
    })();
  }

  rejected(todoId: number): Set<string> {
    const rows = this.db.prepare('select session_id from todo_rejections where todo_id = ?').all(todoId) as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  }
}
