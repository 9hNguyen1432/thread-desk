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

function sessionId(app: ThreadDesk, value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value) || !app.store.session(value)) throw new HttpError(400, 'Unknown thread');
  return value;
}

function dayParam(app: ThreadDesk, value: string | undefined): Day {
  if (!value || value === 'today') return app.todos.today();
  if (!isDay(value)) throw new HttpError(400, 'Day must look like 2026-10-20');
  return value;
}

export function todoRoutes(app: ThreadDesk): Hono {
  const r = new Hono();

  r.get('/todos', (c) => {
    const day = dayParam(app, c.req.query('day'));
    return c.json({ day, today: app.todos.today(), todos: app.todos.view(day) });
  });

  r.post('/todos', async (c) => {
    const { text } = await json<{ text: string }>(c);
    const todo = app.todos.create(String(text ?? ''));
    if (!todo) throw new HttpError(400, 'Type what you want to do');
    return c.json({ id: todo.id });
  });

  r.patch('/todos/:id', async (c) => {
    const id = todoId(app, c);
    const patch = await json<{ title?: string; notes?: string | null; status?: TodoStatus }>(c);
    if (patch.title !== undefined || patch.notes !== undefined) {
      const title = patch.title?.trim();
      if (patch.title !== undefined && !title) throw new HttpError(400, 'Title cannot be empty');
      app.todos.store.update(id, { title: title?.slice(0, 200), notes: patch.notes === undefined ? undefined : patch.notes?.trim() || null });
    }
    if (patch.status !== undefined) {
      if (!TODO_STATUSES.includes(patch.status)) throw new HttpError(400, 'Invalid status');
      app.todos.setStatus(id, patch.status);
    }
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
    app.todos.store.unlink(id, sessionId(app, body.sessionId));
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/reject', async (c) => {
    const id = todoId(app, c);
    const body = await json<{ sessionId: string }>(c);
    app.todos.store.reject(id, sessionId(app, body.sessionId));
    app.boardChanged();
    return c.json({ ok: true });
  });

  r.post('/todos/:id/start-draft', async (c) => c.json({ draft: await app.todoStartDraft(todoId(app, c)), projects: app.store.projects() }));

  r.get('/days/:day/capture', (c) => c.json(captureDay(app.todos, dayParam(app, c.req.param('day')))));
  r.get('/days/:day/week', (c) => c.json(weekSummary(app.todos, dayParam(app, c.req.param('day')))));

  return r;
}
