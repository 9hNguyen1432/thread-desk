import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { HttpError, type SettingsPatch, type ThreadDesk } from './app.js';
import { LIFECYCLES, type Lifecycle } from './board.js';
import { SECRET_HEADER, type HookPayload } from './hooks.js';
import { todoRoutes } from './todos/routes.js';

const TOKEN_HEADER = 'x-thread-desk-token';

export interface ServerOptions {
  port: number;
  token: string;
  hookSecret: string;
  webDir?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

export function createServer(app: ThreadDesk, opts: ServerOptions): Hono {
  const web = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const webDir = opts.webDir ?? fileURLToPath(new URL('../web', import.meta.url));

  web.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });

  // DNS-rebinding guard: only answer requests addressed to the loopback host we bound.
  web.use('*', async (c, next) => {
    if (!allowedHosts.has(c.req.header('host') ?? '')) return c.text('Forbidden host', 403);
    await next();
  });

  web.post('/hooks', async (c) => {
    if (!safeEqual(c.req.header(SECRET_HEADER) ?? '', opts.hookSecret)) return c.text('Forbidden', 403);
    const payload = (await c.req.json().catch(() => ({}))) as HookPayload;
    void app.handleHook(payload).catch(() => undefined);
    return c.body(null, 204);
  });

  // The key travels in a header, never a cookie: cookies are shared by every port on 127.0.0.1.
  // EventSource cannot set headers, so the event stream alone accepts it as a query parameter.
  const authed = (c: Context) => {
    const token = c.req.header(TOKEN_HEADER) ?? (c.req.path === '/api/events' ? c.req.query('t') : undefined) ?? '';
    return safeEqual(token, opts.token);
  };

  web.use('/api/*', async (c, next) => {
    if (!authed(c)) return c.json({ error: 'Unauthorized' }, 401);
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin');
      if (origin && !allowedOrigins.has(origin)) return c.json({ error: 'Forbidden origin' }, 403);
      if (!(c.req.header('content-type') ?? '').includes('application/json')) return c.json({ error: 'JSON required' }, 415);
    }
    await next();
  });

  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));
  api.get('/status', async (c) => c.json(await app.status()));

  api.get('/board', (c) => {
    const project = c.req.query('project') || undefined;
    const includeContinued = c.req.query('continued') === '1';
    const cards = app.cards({ project, includeContinued });
    app.refreshRemoteFor(cards);
    const liveTabs = app.live.snapshot.tabs;
    return c.json({
      cards,
      totals: {
        tabs: liveTabs.length,
        memoryBytes: liveTabs.reduce((sum, t) => sum + t.memoryBytes, 0),
        live: cards.filter((card) => card.live).length,
      },
      at: app.live.snapshot.at,
    });
  });

  api.get('/sessions/:id', (c) => {
    const card = app.requireCard(c.req.param('id'));
    return c.json({ card, messages: app.store.messages(card.id, 40), resumeCommand: app.resumeCommand(card.id) });
  });

  api.post('/sessions/:id/lifecycle', async (c) => {
    const { lifecycle } = await body<{ lifecycle: Lifecycle }>(c);
    if (!LIFECYCLES.includes(lifecycle)) throw new HttpError(400, 'Invalid lifecycle');
    return c.json(await app.setLifecycle(c.req.param('id'), lifecycle));
  });

  api.post('/sessions/:id/note', async (c) => {
    const { note } = await body<{ note: string | null }>(c);
    const id = app.requireCard(c.req.param('id')).id;
    app.store.setNote(id, note?.trim().slice(0, 300) || null);
    await app.live.syncBadges(id);
    app.boardChanged();
    return c.json({ card: app.card(id) });
  });

  api.post('/sessions/:id/snooze', async (c) => {
    const { minutes } = await body<{ minutes: number | null }>(c);
    const id = app.requireCard(c.req.param('id')).id;
    app.store.snooze(id, minutes ? Date.now() + Math.min(minutes, 7 * 24 * 60) * 60_000 : null);
    app.boardChanged();
    return c.json({ ok: true });
  });

  api.post('/sessions/:id/open', async (c) => c.json(await app.open(c.req.param('id'))));

  api.post('/sessions/:id/close-tab', async (c) => {
    await app.closeTab(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/sessions/:id/links/hide', async (c) => {
    const { kind, key } = await body<{ kind: string; key: string }>(c);
    const id = app.requireCard(c.req.param('id')).id;
    app.store.hideLink(id, kind, key);
    app.boardChanged();
    return c.json({ ok: true });
  });

  api.post('/sessions/:id/recap', async (c) => {
    await app.recapNow(c.req.param('id'));
    return c.json({ queued: true });
  });

  api.get('/sessions/:id/handoff', (c) => c.json(app.handoff(c.req.param('id'))));
  api.post('/sessions/:id/handoff', async (c) => {
    const { target, text } = await body<{ target: { kind: string; key: string }; text: string }>(c);
    await app.postHandoff(c.req.param('id'), target, text);
    return c.json({ ok: true });
  });

  api.get('/search', (c) => c.json({ hits: app.search(c.req.query('q') ?? '') }));
  api.get('/inbox', (c) => c.json({ cards: app.inbox() }));
  api.get('/cleanup', (c) => c.json({ suggestions: app.cleanup() }));
  api.post('/cleanup/close', async (c) => {
    const { sessionIds, markDone } = await body<{ sessionIds: string[]; markDone?: boolean }>(c);
    if (!Array.isArray(sessionIds) || sessionIds.length > 200) throw new HttpError(400, 'sessionIds required');
    return c.json({ results: await app.closeMany(sessionIds, Boolean(markDone)) });
  });

  api.get('/tickets', (c) => c.json({ tickets: app.tickets() }));
  api.get('/digest', (c) => {
    const to = Number(c.req.query('to')) || Date.now();
    const from = Number(c.req.query('from')) || to - 24 * 3_600_000;
    if (from >= to) throw new HttpError(400, 'from must be before to');
    return c.json(app.digest(from, to));
  });

  api.post('/start/draft', async (c) => {
    const { input } = await body<{ input: string }>(c);
    return c.json({ draft: await app.startDraft(String(input ?? '')), projects: app.store.projects() });
  });
  api.post('/start/launch', async (c) => {
    const req = await body<{ cwd: string; title: string; prompt: string; worktree: boolean; branch: string; key: string | null; todoId?: number }>(c);
    const todoId = Number.isInteger(req.todoId) && app.todos.store.get(req.todoId!) ? req.todoId : undefined;
    return c.json(
      await app.launch({
        cwd: String(req.cwd ?? ''),
        title: String(req.title ?? ''),
        prompt: String(req.prompt ?? ''),
        worktree: Boolean(req.worktree),
        branch: String(req.branch ?? ''),
        key: req.key ? String(req.key) : null,
      }, todoId),
    );
  });

  api.patch('/settings', async (c) => {
    await app.updateSettings(await body<SettingsPatch>(c));
    return c.json(await app.status());
  });

  api.post('/reindex', async (c) => {
    void app.reindex();
    return c.json({ started: true });
  });

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const onBoard = () => void stream.writeSSE({ event: 'board', data: String(Date.now()) });
      const onToast = (t: { message: string; sessionId?: string }) => void stream.writeSSE({ event: 'toast', data: JSON.stringify(t) });
      app.bus.on('board', onBoard);
      app.bus.on('toast', onToast);
      stream.onAbort(() => {
        app.bus.off('board', onBoard);
        app.bus.off('toast', onToast);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(25_000);
      }
    }),
  );

  api.route('/', todoRoutes(app));
  web.route('/api', api);

  if (existsSync(webDir)) {
    web.use('/*', serveStatic({ root: webDir }));
    web.get('*', serveStatic({ root: webDir, path: 'index.html' }));
  } else {
    web.get('*', (c) => c.text('Web UI not built. Run `npm run build:web`.', 503));
  }

  return web;
}
