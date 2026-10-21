import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AskRunner, askArgs, combineAnswers, type AskItem } from '../src/ask.js';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { DEFAULT_LABEL_RULES, DEFAULT_LABELS, compileRules, resolveLabels, ruleLabel } from '../src/labels.js';
import type { Card } from '../src/store.js';
import { importCandidates } from '../src/todos/importing.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const DAY = 86_400_000;

function card(id: string, over: Partial<Card>): Card {
  return {
    id,
    title: id,
    cwd: '/w',
    project: '/w',
    projectName: 'w',
    branch: null,
    firstAt: NOW - DAY,
    lastAt: NOW - 3_600_000,
    lastHumanAt: null,
    lastAssistantAt: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    humanCount: 1,
    messageCount: 2,
    lifecycle: 'active',
    note: null,
    doneAt: null,
    snoozedUntil: null,
    column: 'idle',
    live: 'idle',
    agent: null,
    tab: { ref: 'workspace:1', windowRef: 'window:1', title: id, memoryBytes: 1 },
    closeBlock: null,
    todos: [],
    label: null,
    links: [],
    mentioned: [],
    primaryTicket: null,
    recap: null,
    recapAt: null,
    transcriptExists: true,
    continuedIn: null,
    claudeVersion: null,
    ...over,
  };
}

describe('importCandidates', () => {
  it('groups threads by ticket, ticks recent work and skips finished or already planned threads', () => {
    const groups = importCandidates(
      [
        card('a', { primaryTicket: 'ENG-1', title: 'Checkout page' }),
        card('b', { primaryTicket: 'ENG-1', title: 'ENG-1 follow-up', lastAt: NOW - 10 * DAY, tab: null }),
        card('c', { title: 'Old idle tab', lastAt: NOW - 10 * DAY }),
        card('d', { lifecycle: 'done' }),
        card('e', { todos: [{ id: 1, title: 't' }] }),
        card('f', { tab: null, lastAt: NOW - 30 * DAY }),
      ],
      new Map([['ENG-1', { id: 7, title: 'Existing ENG-1 todo' }]]),
      NOW,
    );
    expect(groups[0]!.existingTodo).toEqual({ id: 7, title: 'Existing ENG-1 todo' });
    expect(groups[1]!.existingTodo).toBeNull();
    expect(groups.map((g) => [g.key, g.threads.map((t) => t.id), g.suggested])).toEqual([
      ['ticket:ENG-1', ['a', 'b'], true],
      ['thread:c', ['c'], false],
    ]);
    expect(groups[0]!.title).toBe('ENG-1 Checkout page');
  });
});

describe('labels', () => {
  const rules = compileRules(DEFAULT_LABEL_RULES, DEFAULT_LABELS);

  it('labels by branch and text, first rule wins', () => {
    expect(ruleLabel(rules, { branch: 'feat/eng-1-cart', title: 'Cart', firstPrompt: null })).toBe('Feature');
    expect(ruleLabel(rules, { branch: 'fix/x', title: 'Checkout', firstPrompt: null })).toBe('Bug');
    expect(ruleLabel(rules, { branch: 'main', title: 'Thread Slack về ticket support', firstPrompt: null })).toBe('Support');
    expect(ruleLabel(rules, { branch: 'main', title: 'PR 627 and 1738 review', firstPrompt: null })).toBe('Review');
    expect(ruleLabel(rules, { branch: 'main', title: 'Something else', firstPrompt: 'tidy imports' })).toBeNull();
  });

  it('ignores invalid patterns and unknown labels', () => {
    expect(compileRules([{ label: 'Bug', text: '(' }, { label: 'Nope', text: 'x' }], ['Bug'])).toEqual([]);
  });

  it('prefers your choice, then rules, then an AI guess', () => {
    const stored = new Map([
      ['m', { name: 'Ops', source: 'manual' as const }],
      ['none', { name: '', source: 'manual' as const }],
      ['ai', { name: 'Review', source: 'ai' as const }],
      ['ai-rule', { name: 'Review', source: 'ai' as const }],
    ]);
    const out = resolveLabels(stored, rules, [
      { id: 'm', branch: 'fix/x', title: 'x', firstPrompt: null },
      { id: 'none', branch: 'fix/x', title: 'x', firstPrompt: null },
      { id: 'ai', branch: 'main', title: 'tidy', firstPrompt: null },
      { id: 'ai-rule', branch: 'feat/y', title: 'tidy', firstPrompt: null },
    ]);
    expect(out.get('m')).toEqual({ name: 'Ops', source: 'manual' });
    expect(out.get('none')).toEqual({ name: '', source: 'manual' });
    expect(out.get('ai')).toEqual({ name: 'Review', source: 'ai' });
    expect(out.get('ai-rule')).toEqual({ name: 'Feature', source: 'rule' });
  });
});

describe('ask', () => {
  it('uses a forked, unsaved, read-only session', () => {
    const args = askArgs('q', 'sid', 'sonnet');
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sid', '--fork-session', '--no-session-persistence', '--strict-mcp-config']));
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
  });

  it('combines only included answers', () => {
    const items: AskItem[] = [
      { sessionId: 'a', title: 'A', position: 0, status: 'done', answer: 'one', error: null, included: true, sizeBytes: 1 },
      { sessionId: 'b', title: 'B', position: 1, status: 'done', answer: 'two', error: null, included: false, sizeBytes: 1 },
      { sessionId: 'c', title: 'C', position: 2, status: 'failed', answer: null, error: 'x', included: true, sizeBytes: 1 },
    ];
    expect(combineAnswers(items, 'What happened?')).toBe('Question asked to 1 thread: What happened?\n\n## A\n\none\n');
  });

  it('asks threads one at a time with the read-only flags and records failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'td-ask-'));
    const work = join(root, 'work');
    mkdirSync(work);
    mkdirSync(join(root, 'data'));
    const log = join(root, 'calls.log');
    const fake = join(root, 'claude');
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> '${log}'\nfor a in "$@"; do last="$a"; done\ncase "$*" in *bad-session*) exit 3;; esac\nprintf '{"result":"answer from %s"}' "$(echo "$@" | sed 's/.*--resume \\([^ ]*\\).*/\\1/')"\n`,
    );
    chmodSync(fake, 0o755);
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.claudeBin = fake;
    const db = openDb(join(root, 'data'));
    const sessions: Record<string, { title: string; cwd: string | null; file: string | null; transcriptExists: boolean }> = {
      'good-session': { title: 'Good', cwd: work, file: null, transcriptExists: true },
      'bad-session': { title: 'Bad', cwd: work, file: null, transcriptExists: true },
      'gone-folder': { title: 'Gone', cwd: join(root, 'missing'), file: null, transcriptExists: true },
    };
    const runner = new AskRunner(db, () => config, (id) => sessions[id] ?? null, () => undefined);
    expect(() => runner.create(['nope'], 'q', 'sonnet')).toThrow(/no transcript/);
    expect(() => runner.create(['good-session'], 'q', 'bad model!')).toThrow(/model/);

    const id = runner.create(['good-session', 'bad-session', 'gone-folder'], 'What happened?', 'sonnet');
    for (let i = 0; i < 50 && runner.get(id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    const batch = runner.get(id)!;
    expect(batch.status).toBe('done');
    expect(batch.items.map((i) => [i.sessionId, i.status])).toEqual([
      ['good-session', 'done'],
      ['bad-session', 'failed'],
      ['gone-folder', 'failed'],
    ]);
    expect(batch.items[0]!.answer).toBe('answer from good-session');
    expect(batch.items[2]!.error).toMatch(/folder no longer exists/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--tools Read,Grep,Glob');

    const out = join(root, 'cases.md');
    expect(runner.save(id, out)).toBe(out);
    expect(readFileSync(out, 'utf8')).toContain('## Good');
    expect(() => runner.save(id, out)).toThrow(/already exists/);
    expect(() => runner.save(id, 'relative.md')).toThrow(/full path/);
  });
});
