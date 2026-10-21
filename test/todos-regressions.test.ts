import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { ticketRegex } from '../src/links.js';
import type { LiveSnapshot } from '../src/live/state.js';
import { Searcher } from '../src/search.js';
import { Store } from '../src/store.js';
import { addDays, dayOf, dayRange, isDay } from '../src/todos/day.js';
import { closedOn, statusOnDay, visibleOn } from '../src/todos/history.js';
import { captureDay } from '../src/todos/journal.js';
import { TodoService } from '../src/todos/service.js';
import { Indexer } from '../src/transcript/indexer.js';

const live: LiveSnapshot = { agents: new Map(), tabs: [], tabBySession: new Map(), sessionByTab: new Map(), terminal: 'none', errors: [], at: 0 };
const MIN = 60_000;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('history', () => {
  const ev = (day: string, kind: string, at: number) => ({ day, kind, at });

  it('keeps past days intact after a todo is reopened', () => {
    const events = [ev('2026-10-18', 'created', 1), ev('2026-10-18', 'done', 2), ev('2026-10-20', 'todo', 3)];
    expect(statusOnDay(events, '2026-10-18')).toBe('done');
    expect(closedOn(events, '2026-10-18')).toBe(true);
    expect(visibleOn('2026-10-18', events, '2026-10-19')).toBe(false);
    expect(statusOnDay(events, '2026-10-20')).toBe('todo');
    expect(visibleOn('2026-10-18', events, '2026-10-20')).toBe(true);
  });

  it('shows a todo closed and reopened on the same day as open', () => {
    const events = [ev('2026-10-20', 'done', 1), ev('2026-10-20', 'wip', 2)];
    expect(statusOnDay(events, '2026-10-20')).toBe('wip');
    expect(closedOn(events, '2026-10-20')).toBe(false);
  });
});

describe('day boundaries across DST', () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it('agrees with dayRange on the days clocks change', () => {
    process.env.TZ = 'America/New_York';
    expect(dayOf(new Date(2026, 2, 8, 4, 30).getTime(), 4)).toBe('2026-03-08');
    expect(dayOf(new Date(2026, 10, 1, 3, 30).getTime(), 4)).toBe('2026-10-31');
    expect(dayOf(new Date(2026, 10, 1, 4, 30).getTime(), 4)).toBe('2026-11-01');
  });

  it('rejects impossible dates', () => {
    expect(isDay('2026-02-31')).toBe(false);
    expect(isDay('2026-02-28')).toBe(true);
  });
});

describe('schema upgrade', () => {
  it('keeps hidden links when upgrading from version 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-upgrade-'));
    openDb(dir).close();
    const raw = new Database(join(dir, 'index.db'));
    raw.prepare("insert into links (session_id, kind, key, url, mentions, source, hidden) values (?, 'ticket', 'ENG-1', null, 1, 'user', 1)").run(A);
    raw.pragma('user_version = 2');
    raw.close();
    const db = openDb(dir);
    expect(db.prepare('select hidden from links where session_id = ?').get(A)).toEqual({ hidden: 1 });
    db.close();
  });
});

describe('TodoService regressions', () => {
  let db: DB;
  let svc: TodoService;
  let indexer: Indexer;
  let projectDir: string;
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.links.ticketKeys = ['ENG'];

  const file = (id: string) => join(projectDir, `${id}.jsonl`);
  const write = (id: string, cwd: string, messages: [number, 'user' | 'assistant', string][]) => {
    writeFileSync(
      file(id),
      messages
        .map(([ts, role, text]) =>
          JSON.stringify({ type: role, timestamp: new Date(ts).toISOString(), cwd, sessionId: id, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } }),
        )
        .join('\n') + '\n',
    );
  };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'td-reg-'));
    const claudeDir = join(root, 'claude');
    projectDir = join(claudeDir, 'projects', '-w-app');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(root, 'data'));
    db = openDb(join(root, 'data'));
    const store = new Store(db);
    svc = new TodoService({
      db,
      config: () => config,
      searcher: new Searcher(db),
      ticketRe: () => ticketRegex(config.links.ticketKeys),
      cards: () => store.cards({ includeContinued: true }, live, new Map()),
      changed: () => undefined,
    });
    indexer = new Indexer(db, claudeDir, config.links.ticketKeys, {
      sessionsChanged: (ids) => svc.onSessionsChanged(ids),
      sessionsReopened: () => undefined,
    });
  });

  it('does not lose time when a thread is also linked to a todo closed days ago', async () => {
    const today = svc.today();
    const { start } = dayRange(today, config.day.startHour);
    const old = svc.create('Old finished work')!;
    db.prepare('update todos set reported_day = ? where id = ?').run(addDays(today, -4), old.id);
    db.prepare("update todo_events set day = ? where todo_id = ?").run(addDays(today, -4), old.id);
    const current = svc.create('Current work')!;
    write(A, '/w/app', [
      [start + 60 * MIN, 'user', 'go'],
      [start + 80 * MIN, 'user', 'more'],
    ]);
    await indexer.scanAll();
    svc.link(old.id, A, 'manual');
    svc.link(current.id, A, 'manual');
    db.prepare("insert into todo_events (todo_id, day, kind, at) values (?, ?, 'done', ?)").run(old.id, addDays(today, -3), Date.now() + 1);
    db.prepare("update todos set status = 'done', closed_day = ? where id = ?").run(addDays(today, -3), old.id);
    const capture = captureDay(svc, today);
    expect(capture.totalMinutes).toBe(20);
    expect(capture.lines.find((l) => l.todoId === current.id)?.minutes).toBe(20);
  });

  it('only links the newly started thread for a launch, not an older one with a shorter prompt', async () => {
    write(A, '/w/app', [[Date.now() - 3 * 86_400_000, 'user', 'Fix login']]);
    await indexer.scanAll();
    const todo = svc.create('Fix login crash on Android')!;
    svc.registerLaunch(todo.id, '/w/app', 'Fix login crash on Android');
    write(A, '/w/app', [
      [Date.now() - 3 * 86_400_000, 'user', 'Fix login'],
      [Date.now(), 'user', 'still here'],
    ]);
    await indexer.syncPath(file(A));
    write(B, '/w/app', [[Date.now(), 'user', 'Fix login crash on Android']]);
    await indexer.syncPath(file(B));
    expect(svc.view(svc.today())[0]!.threads.map((t) => [t.id, t.origin])).toEqual([[B, 'started']]);
  });

  it('never auto-links on a shared Figma link', async () => {
    svc.create('Polish https://www.figma.com/design/AbCdEfGhIjKlMnOp/Onboarding');
    write(A, '/w/app', [[Date.now(), 'user', 'see https://www.figma.com/design/AbCdEfGhIjKlMnOp/Onboarding for spacing']]);
    await indexer.syncPath(file(A));
    const [view] = svc.view(svc.today(), { suggest: true });
    expect(view!.threads).toEqual([]);
    expect(view!.suggestions[0]?.sessionId).toBe(A);
  });

  it('keeps an unlinked thread unlinked when it writes again', async () => {
    const todo = svc.create('ENG-5 checkout bug')!;
    write(A, '/w/app', [[Date.now(), 'user', 'ENG-5 checkout fails']]);
    await indexer.syncPath(file(A));
    expect(svc.view(svc.today())[0]!.threads).toHaveLength(1);
    svc.store.reject(todo.id, A);
    write(A, '/w/app', [
      [Date.now() - 1000, 'user', 'ENG-5 checkout fails'],
      [Date.now(), 'user', 'one more try'],
    ]);
    await indexer.syncPath(file(A));
    expect(svc.view(svc.today())[0]!.threads).toEqual([]);
  });

  it('respects a manual move back to To do until new work arrives', async () => {
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const todo = svc.create('Manual status')!;
    await pause();
    const t0 = Date.now();
    write(A, '/w/app', [[t0, 'user', 'start']]);
    await indexer.scanAll();
    svc.link(todo.id, A, 'manual');
    expect(svc.store.get(todo.id)!.status).toBe('wip');
    await pause();
    svc.setStatus(todo.id, 'todo');
    await pause();
    const t1 = Date.now();
    write(A, '/w/app', [
      [t0, 'user', 'start'],
      [t1, 'assistant', 'working on it'],
    ]);
    await indexer.syncPath(file(A));
    expect(svc.store.get(todo.id)!.status).toBe('todo');
    await pause();
    write(A, '/w/app', [
      [t0, 'user', 'start'],
      [t1, 'assistant', 'working on it'],
      [Date.now(), 'user', 'next step'],
    ]);
    await indexer.syncPath(file(A));
    expect(svc.store.get(todo.id)!.status).toBe('wip');
  });

  it('does not call a closed, unmerged PR merged', async () => {
    const todo = svc.create('Ship the change')!;
    write(A, '/w/app', [[Date.now(), 'user', 'ship']]);
    await indexer.scanAll();
    svc.link(todo.id, A, 'manual');
    db.prepare("insert into links (session_id, kind, key, url, mentions, source) values (?, 'pr', 'a/b#1', 'https://github.com/a/b/pull/1', 0, 'pr-link')").run(A);
    db.prepare("insert into remote_status (kind, key, state, category, fetched_at) values ('pr', 'a/b#1', 'CLOSED', 'done', 1)").run();
    expect(svc.view(svc.today())[0]!.doneHint).toBeNull();
    db.prepare("update remote_status set state = 'MERGED' where key = 'a/b#1'").run();
    expect(svc.view(svc.today())[0]!.doneHint).toBe('Its PR is merged');
  });
});

describe('WIP for work done earlier the same day', () => {
  it('marks a todo written after starting its thread today as WIP once linked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'td-wip-'));
    const claudeDir = join(root, 'claude');
    const dir = join(claudeDir, 'projects', '-w-app');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'data'));
    const db = openDb(join(root, 'data'));
    const config: Config = structuredClone(DEFAULT_CONFIG);
    const store = new Store(db);
    const svc = new TodoService({
      db,
      config: () => config,
      searcher: new Searcher(db),
      ticketRe: () => null,
      cards: () => store.cards({ includeContinued: true }, live, new Map()),
      changed: () => undefined,
    });
    const indexer = new Indexer(db, claudeDir, [], { sessionsChanged: () => undefined, sessionsReopened: () => undefined });
    const { start } = dayRange(svc.today(), config.day.startHour);
    const ts = Math.max(start + MIN, Date.now() - 10 * MIN);
    writeFileSync(join(dir, `${A}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date(ts).toISOString(), cwd: '/w/app', sessionId: A, message: { role: 'user', content: 'early start' } }) + '\n');
    await indexer.scanAll();
    const todo = svc.create('Written later')!;
    svc.link(todo.id, A, 'manual');
    expect(svc.store.get(todo.id)!.status).toBe('wip');
  });
});
