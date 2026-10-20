import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { ticketRegex } from '../src/links.js';
import { Searcher } from '../src/search.js';
import { Store } from '../src/store.js';
import { Indexer } from '../src/transcript/indexer.js';
import type { LiveSnapshot } from '../src/live/state.js';

const ID = '11111111-2222-4333-8444-555555555555';
const NEXT = '66666666-7777-4888-9999-000000000000';

const emptyLive: LiveSnapshot = { agents: new Map(), tabs: [], tabBySession: new Map(), sessionByTab: new Map(), terminal: 'none', errors: [], at: 0 };

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function user(text: string, ts: string): string {
  return line({ type: 'user', timestamp: ts, cwd: '/nowhere/app', gitBranch: 'feat/cn-77-login', sessionId: ID, message: { role: 'user', content: text } });
}

function assistant(text: string, ts: string): string {
  return line({ type: 'assistant', timestamp: ts, cwd: '/nowhere/app', sessionId: ID, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

describe('Indexer', () => {
  let db: DB;
  let file: string;
  let indexer: Indexer;
  let reopened: string[];
  let claudeDir: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'td-index-'));
    claudeDir = join(root, 'claude');
    const dir = join(claudeDir, 'projects', '-nowhere-app');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'data'));
    db = openDb(join(root, 'data'));
    file = join(dir, `${ID}.jsonl`);
    reopened = [];
    indexer = new Indexer(db, claudeDir, ['CN'], {
      sessionsChanged: () => undefined,
      sessionsReopened: (ids) => reopened.push(...ids),
    });
  });

  it('indexes a transcript and extracts links from prompts, branch and PR records', async () => {
    writeFileSync(
      file,
      line({ type: 'custom-title', customTitle: 'Login fix', sessionId: ID }) +
        user('Fix the Phán đoán bug, see https://acme.slack.com/archives/C01/p1729400000123456', '2026-10-20T07:00:00Z') +
        assistant('Opened https://github.com/a/b/pull/9', '2026-10-20T07:01:00Z') +
        line({ type: 'pr-link', sessionId: ID, prNumber: 9, prUrl: 'https://github.com/a/b/pull/9', prRepository: 'a/b' }),
    );
    await indexer.scanAll();
    const store = new Store(db);
    const card = store.card(ID, emptyLive, new Map());
    expect(card).toMatchObject({ title: 'Login fix', branch: 'feat/cn-77-login', humanCount: 1, messageCount: 2, column: 'paused', primaryTicket: 'CN-77' });
    expect(card?.links.map((l) => `${l.kind}:${l.key}:${l.source}`).sort()).toEqual([
      'pr:a/b#9:pr-link',
      'slack:acme/C01/1729400000.123456:user',
      'ticket:CN-77:branch',
    ]);

    const searcher = new Searcher(db);
    const titles = new Map([[ID, 'Login fix']]);
    expect(searcher.search('phan doan', ticketRegex(['CN']), titles)[0]).toMatchObject({ sessionId: ID, matchedBy: 'text' });
    expect(searcher.search('CN-77', ticketRegex(['CN']), titles)[0]).toMatchObject({ sessionId: ID, matchedBy: 'link' });
    expect(searcher.search('https://github.com/a/b/pull/9', null, titles)[0]).toMatchObject({ sessionId: ID, matchedBy: 'link' });
  });

  it('reads appended lines incrementally and waits for a partial last line', async () => {
    writeFileSync(file, user('first', '2026-10-20T07:00:00Z'));
    await indexer.scanAll();
    const partial = assistant('second', '2026-10-20T07:01:00Z');
    appendFileSync(file, partial.slice(0, 20));
    await indexer.syncPath(file);
    expect(new Store(db).session(ID)?.message_count).toBe(1);
    appendFileSync(file, partial.slice(20));
    await indexer.syncPath(file);
    expect(new Store(db).session(ID)).toMatchObject({ message_count: 2, last_assistant: 'second' });
  });

  it('rebuilds a session when its file shrinks', async () => {
    writeFileSync(file, user('one', '2026-10-20T07:00:00Z') + user('two', '2026-10-20T07:01:00Z'));
    await indexer.scanAll();
    writeFileSync(file, user('only', '2026-10-20T08:00:00Z'));
    await indexer.syncPath(file);
    expect(new Store(db).session(ID)).toMatchObject({ human_count: 1, first_prompt: 'only' });
  });

  it('reopens a done thread when the user writes again, but not for older messages', async () => {
    writeFileSync(file, user('start', '2026-10-20T07:00:00Z'));
    await indexer.scanAll();
    const store = new Store(db);
    store.setLifecycle(ID, 'done');
    db.prepare('update user_state set updated_at = ? where session_id = ?').run(Date.parse('2026-10-20T09:00:00Z'), ID);

    appendFileSync(file, user('late echo', '2026-10-20T08:00:00Z'));
    await indexer.syncPath(file);
    expect(store.lifecycleOf(ID).lifecycle).toBe('done');

    appendFileSync(file, user('one more thing', '2026-10-20T10:00:00Z'));
    await indexer.syncPath(file);
    expect(store.lifecycleOf(ID).lifecycle).toBe('active');
    expect(reopened).toEqual([ID]);
  });

  it('follows continued sessions to the newest one and hides the old one from the board', async () => {
    writeFileSync(file, user('old', '2026-10-20T07:00:00Z') + line({ type: 'continued-in', sessionId: ID, continuedInSessionId: NEXT }));
    writeFileSync(join(claudeDir, 'projects', '-nowhere-app', `${NEXT}.jsonl`), user('new', '2026-10-20T08:00:00Z'));
    await indexer.scanAll();
    const store = new Store(db);
    expect(store.latestInChain(ID)).toBe(NEXT);
    expect(store.cards({}, emptyLive, new Map()).map((c) => c.id)).toEqual([NEXT]);
  });

  it('marks deleted transcripts as missing but keeps them searchable', async () => {
    writeFileSync(file, user('remember me', '2026-10-20T07:00:00Z'));
    await indexer.scanAll();
    const { rmSync } = await import('node:fs');
    rmSync(file);
    await indexer.scanAll();
    const card = new Store(db).card(ID, emptyLive, new Map());
    expect(card?.transcriptExists).toBe(false);
    expect(new Searcher(db).search('remember', null, new Map())[0]?.sessionId).toBe(ID);
  });
});
