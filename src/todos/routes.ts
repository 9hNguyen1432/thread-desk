import { Hono, type Context } from 'hono';
import { HttpError, type ThreadDesk } from '../app.js';
import { isDay, type Day } from './day.js';
import { captureDay, weekSummary } from './journal.js';
import { TODO_STATUSES, type TodoStatus } from './store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function json<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

function todoId(app: ThreadDesk, c: Context): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || !app.todos.store.get(id)) throw new HttpError(404, 'Todo not found');
  return id;
}

function sessionId(app: ThreadDesk, value: unknown, mustExist = true): string {
  if (typeof value !== 'string' || !UUID_RE.test(value) || (mustExist && !app.store.session(value))) throw new HttpError(400, 'Unknown thread');
  return value;
}

const MAX_NOTES = 10_000;

function dayParam(app: ThreadDesk, value: string | undefined): Day {
  if (!value || value === 'today') return app.todos.today();
  if (!isDay(value)) throw new HttpError(400, 'Day must look like 2026-10-20');
  return value;
}

export function todoRoutes(app: ThreadDesk): Hono {
  const r = new Hono();

  r.get('/todos', (c) => {
    const day = dayParam(app, c.req.query('day'));
    return c.json({ day, today: app.todos.today(), todos: app.todos.view(day, { suggest: true }) });
  });

  r.post('/todos', async (c) => {
    const body = await json<{ text?: unknown } | null>(c);
    if (typeof body?.text !== 'string' || body.text.length > MAX_NOTES) throw new HttpError(400, 'Type what you want to do');
    const todo = app.todos.create(body.text);
    if (!todo) throw new HttpError(400, 'Type what you want to do');
    return c.json({ id: todo.id });
  });

  r.patch('/todos/:id', async (c) => {
    const id = todoId(app, c);
    const patch = (await json<{ title?: unknown; notes?: unknown; status?: unknown } | null>(c)) ?? {};
    // Validate everything before changing anything, so a bad field never leaves a partial update.
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) throw new HttpError(400, 'Title cannot be empty');
    if (patch.notes !== undefined && patch.notes !== null && (typeof patch.notes !== 'string' || patch.notes.length > MAX_NOTES)) {
      throw new HttpError(400, 'Notes must be text up to 10,000 characters');
    }
    if (patch.status !== undefined && !TODO_STATUSES.includes(patch.status as TodoStatus)) throw new HttpError(400, 'Invalid status');
    if (patch.title !== undefined || patch.notes !== undefined) {
      app.todos.store.update(id, {
        title: typeof patch.title === 'string' ? patch.title.trim().slice(0, 200) : undefined,
        notes: patch.notes === undefined ? undefined : typeof patch.notes === 'string' ? patch.notes.trim() || null : null,
      });
    }
    if (patch.status !== undefined) app.todos.setStatus(id, patch.status as TodoStatus);
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/delete', async (c) => {
    app.todos.store.remove(todoId(app, c));
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/reorder', async (c) => {
    const { ids } = await json<{ ids: number[] }>(c);
    if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) throw new HttpError(400, 'ids must be numbers');
    app.todos.store.reorder(ids);
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/link', async (c) => {
    const id = todoId(app, c);
    const body = await json<{ sessionId: string; origin?: 'manual' | 'accepted' }>(c);
    app.todos.link(id, sessionId(app, body.sessionId), body.origin === 'accepted' ? 'accepted' : 'manual');
    return c.json({ ok: true });
  });

  r.post('/todos/:id/unlink', async (c) => {
    const id = todoId(app, c);
    const body = await json<{ sessionId: string }>(c);
    app.todos.store.reject(id, sessionId(app, body.sessionId, false));
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/reject', async (c) => {
    const id = todoId(app, c);
    const body = await json<{ sessionId: string }>(c);
    app.todos.store.reject(id, sessionId(app, body.sessionId, false));
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/start-draft', async (c) => c.json({ draft: await app.todoStartDraft(todoId(app, c)), projects: app.store.projects() }));

  r.get('/days/:day/capture', (c) => c.json(captureDay(app.todos, dayParam(app, c.req.param('day')))));
  r.get('/days/:day/week', (c) => c.json(weekSummary(app.todos, dayParam(app, c.req.param('day')))));

  return r;
}
