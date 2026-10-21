import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { ticketRegex } from '../src/links.js';
import type { LiveSnapshot } from '../src/live/state.js';
import { Searcher } from '../src/search.js';
import { Store } from '../src/store.js';
import { activeMinutes } from '../src/todos/activity.js';
import { addDays, dayOf, dayRange, weekStart } from '../src/todos/day.js';
import { captureDay, formatMinutes } from '../src/todos/journal.js';
import { significantWords } from '../src/todos/matching.js';
import { TodoService, splitTodoText } from '../src/todos/service.js';
import { Indexer } from '../src/transcript/indexer.js';

const live: LiveSnapshot = { agents: new Map(), tabs: [], tabBySession: new Map(), sessionByTab: new Map(), terminal: 'none', errors: [], at: 0 };
const MIN = 60_000;

function at(day: string, hh: number, mm = 0): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hh, mm).getTime();
}

describe('day helpers', () => {
  it('counts work before the start hour as the previous day', () => {
    expect(dayOf(at('2026-10-21', 1, 30), 4)).toBe('2026-10-20');
    expect(dayOf(at('2026-10-21', 4, 0), 4)).toBe('2026-10-21');
    expect(dayOf(at('2026-10-21', 1, 30), 0)).toBe('2026-10-21');
  });

  it('builds ranges, adds days and finds the Monday', () => {
    const { start, end } = dayRange('2026-10-20', 4);
    expect(start).toBe(at('2026-10-20', 4));
    expect(end).toBe(at('2026-10-21', 4));
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(weekStart('2026-10-22')).toBe('2026-10-19');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
  });
});

describe('activeMinutes', () => {
  it('sums short gaps and skips long breaks', () => {
    const t = at('2026-10-20', 9);
    expect(activeMinutes([t, t + 5 * MIN, t + 12 * MIN, t + 60 * MIN, t + 63 * MIN], 20)).toBe(15);
    expect(activeMinutes([t], 20)).toBe(0);
  });

  it('formats minutes', () => {
    expect(formatMinutes(35)).toBe('35m');
    expect(formatMinutes(110)).toBe('1h50');
    expect(formatMinutes(120)).toBe('2h');
  });
});

describe('splitTodoText and significantWords', () => {
  it('uses the first line as title and the rest as notes', () => {
    expect(splitTodoText('\n  CS ticket: OTP missing \nUser says no code\nsince Monday')).toEqual({
      title: 'CS ticket: OTP missing',
      notes: 'User says no code\nsince Monday',
    });
    expect(splitTodoText('   ')).toEqual({ title: '', notes: null });
  });

  it('keeps distinctive words and drops links, keys and filler', () => {
    expect(significantWords('Refund the blast replacement for ENG-12 https://x.slack.com/archives/C1/p1 and the user')).toEqual([
      'refund',
      'blast',
      'replacement',
      'user',
    ]);
  });
});

describe('TodoService', () => {
  let db: DB;
  let svc: TodoService;
  let indexer: Indexer;
  let projectDir: string;
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.links.ticketKeys = ['ENG'];

  const sessionFile = (id: string) => join(projectDir, `${id}.jsonl`);
  const writeSession = (id: string, cwd: string, messages: [string, 'user' | 'assistant', string][], extra = '') => {
    let out = extra;
    for (const [ts, role, text] of messages) {
      const content = role === 'user' ? text : [{ type: 'text', text }];
      out += JSON.stringify({ type: role, timestamp: ts, cwd, sessionId: id, message: { role, content } }) + '\n';
    }
    writeFileSync(sessionFile(id), out);
  };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'td-todos-'));
    const claudeDir = join(root, 'claude');
    projectDir = join(claudeDir, 'projects', '-w-app');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(root, 'data'));
    db = openDb(join(root, 'data'));
    const store = new Store(db);
    const searcher = new Searcher(db);
    svc = new TodoService({
      db,
      config: () => config,
      searcher,
      ticketRe: () => ticketRegex(config.links.ticketKeys),
      cards: () => store.cards({ includeContinued: true }, live, new Map()),
      changed: () => undefined,
    });
    indexer = new Indexer(db, claudeDir, config.links.ticketKeys, {
      sessionsChanged: (ids) => svc.onSessionsChanged(ids),
      sessionsReopened: () => undefined,
    });
  });

  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';

  it('auto-links a new thread that mentions the same ticket, but never an older one', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    writeSession(A, '/w/app', [[old, 'user', 'look at ENG-7 again']]);
    await indexer.scanAll();
    const todo = svc.create('Fix ENG-7 login\nfrom support')!;
    const now = new Date().toISOString();
    writeSession(B, '/w/app', [[now, 'user', 'ENG-7: users cannot log in']]);
    await indexer.syncPath(sessionFile(B));

    const [view] = svc.view(svc.today());
    expect(view!.threads.map((t) => [t.id, t.origin])).toEqual([[B, 'auto']]);
    expect(view!.status).toBe('wip');
    expect(view!.suggestions.map((s) => s.sessionId)).toContain(A);
    expect(view!.suggestions.find((s) => s.sessionId === A)?.reason).toMatch(/same ticket/);
    expect(svc.store.get(todo.id)!.status).toBe('wip');
  });

  it('does not auto-link when only Claude mentioned the ticket, and remembers rejections', async () => {
    const todo = svc.create('Investigate ENG-9')!;
    const now = new Date().toISOString();
    writeSession(C, '/w/app', [
      [now, 'user', 'why is checkout slow'],
      [now, 'assistant', 'This looks related to ENG-9.'],
    ]);
    await indexer.syncPath(sessionFile(C));
    let [view] = svc.view(svc.today());
    expect(view!.threads).toEqual([]);
    expect(view!.suggestions[0]?.sessionId).toBe(C);
    svc.store.reject(todo.id, C);
    [view] = svc.view(svc.today());
    expect(view!.suggestions).toEqual([]);
  });

  it('links the thread opened from a todo by its first prompt and folder', async () => {
    const todo = svc.create('Write the billing retry job')!;
    svc.registerLaunch(todo.id, '/w/app', 'Write the billing retry job\n\nUse the existing queue.');
    writeSession(A, '/w/app', [[new Date().toISOString(), 'user', 'Write the billing retry job\n\nUse the existing queue.']]);
    await indexer.syncPath(sessionFile(A));
    expect(svc.view(svc.today())[0]!.threads.map((t) => [t.id, t.origin])).toEqual([[A, 'started']]);
  });

  it('carries unfinished todos forward but keeps the reported day', async () => {
    const todo = svc.create('Carry me')!;
    db.prepare('update todos set reported_day = ? where id = ?').run(addDays(svc.today(), -2), todo.id);
    const [view] = svc.view(svc.today());
    expect(view!.reportedDay).toBe(addDays(svc.today(), -2));
    expect(view!.carriedDays).toBe(2);
    expect(svc.view(addDays(svc.today(), -3))).toEqual([]);
  });

  it('captures only work actually done that day, splits shared threads and guards CSV formulas', async () => {
    const today = svc.today();
    const { start } = dayRange(today, config.day.startHour);
    const iso = (offsetMin: number) => new Date(start + 60 * MIN + offsetMin * MIN).toISOString();
    const worked = svc.create('=HYPERLINK("x") worked on')!;
    const shared = svc.create('Shared thread todo')!;
    svc.create('Reported but untouched');
    writeSession(A, '/w/app', [
      [iso(0), 'user', 'start'],
      [iso(10), 'assistant', 'ok'],
      [iso(20), 'user', 'next'],
    ]);
    writeSession(B, '/w/app', [
      [iso(30), 'user', 'unplanned thing'],
      [iso(36), 'assistant', 'done'],
    ]);
    await indexer.scanAll();
    svc.link(worked.id, A, 'manual');
    svc.link(shared.id, A, 'manual');

    const capture = captureDay(svc, today);
    const byTitle = new Map(capture.lines.map((l) => [l.title, l]));
    expect(byTitle.has('Reported but untouched')).toBe(false);
    expect(byTitle.get('=HYPERLINK("x") worked on')).toMatchObject({ status: 'wip', minutes: 10 });
    expect(byTitle.get('Shared thread todo')).toMatchObject({ status: 'wip', minutes: 10 });
    expect(capture.lines.find((l) => l.status === 'unplanned')).toMatchObject({ minutes: 6 });
    expect(capture.totalMinutes).toBe(26);
    expect(capture.csv).toContain(`'=HYPERLINK`);

    svc.setStatus(worked.id, 'done');
    const after = captureDay(svc, today);
    expect(after.lines.find((l) => l.todoId === worked.id)?.status).toBe('done');
  });

  it('suggests done when every linked thread is done', async () => {
    const todo = svc.create('Ship it')!;
    writeSession(A, '/w/app', [[new Date().toISOString(), 'user', 'ship it']]);
    await indexer.scanAll();
    svc.link(todo.id, A, 'manual');
    new Store(db).setLifecycle(A, 'done');
    expect(svc.view(svc.today())[0]!.doneHint).toBe('All linked threads are done');
  });
});
