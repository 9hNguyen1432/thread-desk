import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentOfProcess, sessionIdInCommand } from '../src/agents.js';
import { openDb, type DB } from '../src/db.js';
import type { LiveSnapshot } from '../src/live/state.js';
import { Store } from '../src/store.js';
import type { Tab } from '../src/terminal/types.js';
import { parseEtime, parsePs } from '../src/terminal/processes.js';
import { copilotSource, sqliteTime } from '../src/transcript/copilot.js';
import { Indexer } from '../src/transcript/indexer.js';
import { codexSource, piSource } from '../src/transcript/sources.js';

const CODEX_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const PI_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const COPILOT_ID = '3f2b8c1e-6a4d-4e0b-9b7a-2d1c5e8f9a01';

const emptyLive: LiveSnapshot = { agents: new Map(), tabs: [], tabBySession: new Map(), sessionByTab: new Map(), guessedTabs: new Set(), terminal: 'none', errors: [], at: 0 };
const json = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const noop = { sessionsChanged: () => undefined, sessionsReopened: () => undefined };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'td-agents-'));
  mkdirSync(join(root, 'data'));
  return { root, db: openDb(join(root, 'data')) };
}

describe('Codex sessions', () => {
  let root: string;
  let db: DB;
  let day: string;

  beforeEach(() => {
    ({ root, db } = setup());
    day = join(root, 'codex', 'sessions', '2026', '10', '22');
    mkdirSync(day, { recursive: true });
  });

  it('reads the header, the user and agent messages, and skips repeated response items', async () => {
    writeFileSync(
      join(day, `rollout-2026-10-22T09-00-00-${CODEX_ID}.jsonl`),
      json([
        { timestamp: '2026-10-22T09:00:00Z', type: 'session_meta', payload: { id: CODEX_ID, cwd: '/nowhere/api', cli_version: '0.163.0', git: { branch: 'feat/ACME-7-export' } } },
        { timestamp: '2026-10-22T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
        { timestamp: '2026-10-22T09:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add CSV export for ACME-7' } },
        { timestamp: '2026-10-22T09:00:09Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Added GET /orders/export.' } },
        { timestamp: '2026-10-22T09:00:09Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added GET /orders/export.' }] } },
        'not json',
      ]),
    );
    const indexer = new Indexer(db, [codexSource(join(root, 'codex'))], ['ACME'], noop);
    await indexer.scanAll();
    const card = new Store(db).card(CODEX_ID, emptyLive, new Map())!;
    expect(card).toMatchObject({
      agentKind: 'codex',
      title: 'Add CSV export for ACME-7',
      cwd: '/nowhere/api',
      branch: 'feat/ACME-7-export',
      humanCount: 1,
      messageCount: 2,
      lastAssistant: 'Added GET /orders/export.',
      claudeVersion: '0.163.0',
      primaryTicket: 'ACME-7',
    });
  });

  it('reads compressed cold sessions, and does not count a session twice when it gets compressed', async () => {
    const dir = join(root, 'codex', 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    const name = `rollout-2026-10-01T08-00-00-${CODEX_ID}.jsonl`;
    const plain = join(dir, name);
    // The plain copy hides a compressed sibling until it is removed.
    writeFileSync(
      plain,
      json([
        { timestamp: '2026-10-01T08:00:00Z', type: 'session_meta', payload: { id: CODEX_ID, cwd: '/nowhere/old' } },
        { timestamp: '2026-10-01T08:00:05Z', type: 'event_msg', payload: { type: 'user_message', message: 'OPS-12: why is the cache cold after deploy?' } },
        { timestamp: '2026-10-01T08:00:30Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The warmup job runs before the new pods are ready.' } },
      ]),
    );
    copyFileSync(join(import.meta.dirname, 'fixtures', 'codex-cold.jsonl.zst'), `${plain}.zst`);
    const indexer = new Indexer(db, [codexSource(join(root, 'codex'))], ['OPS'], noop);
    expect(await indexer.listSessionFiles()).toEqual([plain]);
    await indexer.scanAll();

    rmSync(plain);
    await indexer.scanAll();
    const card = new Store(db).card(CODEX_ID, emptyLive, new Map())!;
    expect(card).toMatchObject({ title: 'OPS-12: why is the cache cold after deploy?', messageCount: 2, branch: 'fix/OPS-12-cache', transcriptExists: true });
  });
});

describe('turning an agent off and on', () => {
  it('brings its unchanged sessions back instead of leaving them marked missing', async () => {
    const { root, db } = setup();
    const day = join(root, 'codex', 'sessions', '2026', '10', '22');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, `rollout-2026-10-22T09-00-00-${CODEX_ID}.jsonl`),
      json([{ timestamp: '2026-10-22T09:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }]),
    );
    const on = () => new Indexer(db, [codexSource(join(root, 'codex'))], [], noop);
    await on().scanAll();
    await new Indexer(db, [], [], noop).scanAll();
    expect(new Store(db).card(CODEX_ID, emptyLive, new Map())!.transcriptExists).toBe(false);
    await on().scanAll();
    expect(new Store(db).card(CODEX_ID, emptyLive, new Map())!.transcriptExists).toBe(true);
  });
});

describe('Pi sessions', () => {
  it('reads the header, messages and a /name title', async () => {
    const { root, db } = setup();
    const dir = join(root, 'pi', 'sessions', '--nowhere-web--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `2026-10-22T10-00-00-000Z_${PI_ID}.jsonl`),
      json([
        { type: 'session', version: 3, id: PI_ID, timestamp: '2026-10-22T10:00:00Z', cwd: '/nowhere/web' },
        { type: 'message', id: 'a1', parentId: null, timestamp: '2026-10-22T10:00:01Z', message: { role: 'user', content: 'Why does the build fail on CI?' } },
        { type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-10-22T10:00:04Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Node 18 on CI.' }] } },
        { type: 'message', id: 'a3', parentId: 'a2', timestamp: '2026-10-22T10:00:05Z', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'output' }] } },
        { type: 'session_info', id: 'a4', parentId: 'a3', timestamp: '2026-10-22T10:01:00Z', name: 'CI build fix' },
      ]),
    );
    await new Indexer(db, [piSource(join(root, 'pi'))], [], noop).scanAll();
    expect(new Store(db).card(PI_ID, emptyLive, new Map())).toMatchObject({
      agentKind: 'pi',
      title: 'CI build fix',
      cwd: '/nowhere/web',
      firstPrompt: 'Why does the build fail on CI?',
      lastAssistant: 'Node 18 on CI.',
      messageCount: 2,
    });
  });
});

describe('Copilot sessions', () => {
  it('reads sessions and turns from the store, waits for unanswered turns, and notices deleted sessions', async () => {
    const { root, db } = setup();
    const home = join(root, 'copilot');
    mkdirSync(home);
    const store = new Database(join(home, 'session-store.db'));
    store.exec(`
      create table sessions (id text primary key, cwd text, repository text, host_type text, branch text, summary text,
        created_at text default (datetime('now')), updated_at text default (datetime('now')));
      create table turns (id integer primary key autoincrement, session_id text not null, turn_index integer not null,
        user_message text, assistant_response text, timestamp text default (datetime('now')), unique(session_id, turn_index));
    `);
    store.prepare("insert into sessions (id, cwd, branch, summary, created_at, updated_at) values (?, '/nowhere/cli', 'main', 'Speed up tests', '2026-10-22 01:00:00', '2026-10-22 01:00:00')").run(COPILOT_ID);
    store.prepare("insert into turns (session_id, turn_index, user_message, assistant_response, timestamp) values (?, 0, 'Make the tests faster', 'Run them in parallel.', '2026-10-22 01:00:10')").run(COPILOT_ID);
    store.prepare("insert into turns (session_id, turn_index, user_message, assistant_response, timestamp) values (?, 1, 'And on CI?', null, '2026-10-22 01:02:00')").run(COPILOT_ID);

    const source = copilotSource(home);
    const indexer = new Indexer(db, [], [], noop, [source]);
    await indexer.scanAll();
    const read = () => new Store(db).card(COPILOT_ID, emptyLive, new Map())!;
    expect(read()).toMatchObject({ agentKind: 'copilot', title: 'Speed up tests', cwd: '/nowhere/cli', branch: 'main', messageCount: 2, lastPrompt: 'Make the tests faster' });
    expect(read().firstAt).toBe(Date.UTC(2026, 9, 22, 1, 0, 0));

    store.prepare("update turns set assistant_response = 'Use the matrix.' where turn_index = 1").run();
    store.prepare("update sessions set updated_at = '2026-10-22 01:03:00'").run();
    await indexer.scanAll();
    expect(read()).toMatchObject({ messageCount: 4, lastPrompt: 'And on CI?', lastAssistant: 'Use the matrix.' });

    store.prepare('delete from turns').run();
    store.prepare('delete from sessions').run();
    await indexer.scanAll();
    expect(read().transcriptExists).toBe(false);
    store.close();
    source.close();
  });

  it('treats SQLite timestamps without a zone as UTC', () => {
    expect(sqliteTime('2026-10-22 01:00:00')).toBe(Date.UTC(2026, 9, 22, 1));
    expect(sqliteTime('2026-10-22T01:00:00+07:00')).toBe(Date.UTC(2026, 9, 21, 18));
    expect(sqliteTime(null)).toBeUndefined();
  });
});

describe('processes and session guessing', () => {
  it('tells agents apart by their command line', () => {
    expect(agentOfProcess({ name: '2.1.306', path: '/u/.local/share/claude/versions/2.1.306' })).toBe('claude');
    expect(agentOfProcess({ name: 'codex', path: '/u/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex' })).toBe('codex');
    expect(agentOfProcess({ name: 'node', command: 'node /u/.nvm/versions/node/v22/bin/pi --session 7c9e' })).toBe('pi');
    expect(agentOfProcess({ name: 'node', command: 'node /u/.nvm/versions/node/v22/bin/copilot' })).toBe('copilot');
    expect(agentOfProcess({ name: 'node', command: 'node /srv/app/index.js' })).toBeNull();
    expect(agentOfProcess({ name: 'vim', command: 'vim codex.md' })).toBeNull();
    expect(sessionIdInCommand(`codex resume ${CODEX_ID.toUpperCase()}`)).toBe(CODEX_ID);
    expect(sessionIdInCommand('pi')).toBeNull();
  });

  it('parses ps output', () => {
    expect(parseEtime('05:03')).toBe(303_000);
    expect(parseEtime('2-01:00:00')).toBe((49 * 3600) * 1000);
    const procs = parsePs('  900     1   900   900  20480  12.5   01:00 node /u/bin/codex resume x\n bad line\n', 100_000);
    expect(procs.get(900)).toEqual({ pid: 900, ppid: 1, pgid: 900, tpgid: 900, rssBytes: 20480 * 1024, cpuPercent: 12.5, startedAt: 40_000, command: 'node /u/bin/codex resume x', name: 'node' });
  });

  it('guesses the newest session of the same agent in the folder since the process started', () => {
    const { db } = setup();
    const insert = db.prepare('insert into sessions (id, agent, file, cwd, last_at) values (?, ?, ?, ?, ?)');
    insert.run('a', 'codex', 'a', '/w', 1_000_000);
    insert.run('b', 'codex', 'b', '/w', 2_000_000);
    insert.run('c', 'pi', 'c', '/w', 2_100_000);
    insert.run('d', 'codex', 'd', '/elsewhere', 2_200_000);
    const store = new Store(db);
    const tab = { agentKind: 'codex', cwd: '/w', agentStartedAt: 3_000_000 } as Tab;
    expect(store.guessSession(tab, new Set())).toBeNull();
    // A minute of slack covers a session whose first line lands just before the process is seen.
    expect(store.guessSession({ ...tab, agentStartedAt: 2_050_000 }, new Set())).toBe('b');
    expect(store.guessSession({ ...tab, agentStartedAt: 1_900_000 }, new Set(['b']))).toBeNull();
    expect(store.guessSession({ ...tab, agentStartedAt: null }, new Set(['b']))).toBe('a');
  });
});
