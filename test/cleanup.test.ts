import { describe, expect, it } from 'vitest';
import { suggestCleanup } from '../src/cleanup.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Card, LinkView } from '../src/store.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3_600_000;

function card(over: Partial<Card>): Card {
  return {
    id: 'id',
    title: 'Thread',
    cwd: '/w',
    project: '/w',
    projectName: 'w',
    branch: null,
    firstAt: NOW - 10 * HOUR,
    lastAt: NOW - HOUR,
    lastHumanAt: null,
    lastAssistantAt: null,
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
    tab: { ref: 'workspace:1', windowRef: 'window:1', title: 't', memoryBytes: 500e6 },
    closeBlock: null,
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

function link(over: Partial<LinkView>): LinkView {
  return { kind: 'pr', key: 'a/b#1', url: null, mentions: 1, source: 'pr-link', state: 'MERGED', category: 'done', title: null, ...over };
}

const cfg = DEFAULT_CONFIG.cleanup;

describe('suggestCleanup', () => {
  it('never suggests tabs that cannot be closed safely or threads without a tab', () => {
    expect(suggestCleanup([card({ lifecycle: 'done', closeBlock: 'Claude is still working in this tab; stop it first' })], cfg, NOW)).toEqual([]);
    expect(suggestCleanup([card({ tab: null, lifecycle: 'done' })], cfg, NOW)).toEqual([]);
  });

  it('suggests done threads and threads whose own PRs are all closed', () => {
    const [done] = suggestCleanup([card({ lifecycle: 'done' })], cfg, NOW);
    expect(done?.reasons).toEqual(['marked_done']);
    const [merged] = suggestCleanup([card({ links: [link({}), link({ key: 'a/b#2', state: 'CLOSED' })] })], cfg, NOW);
    expect(merged?.reasons).toEqual(['pr_closed']);
  });

  it('ignores PRs Claude merely mentioned and open PRs', () => {
    expect(suggestCleanup([card({ links: [link({ source: 'assistant' })] })], cfg, NOW)).toEqual([]);
    expect(suggestCleanup([card({ links: [link({}), link({ key: 'a/b#2', state: 'OPEN', category: 'open' })] })], cfg, NOW)).toEqual([]);
  });

  it('suggests threads whose primary ticket is done', () => {
    const c = card({ primaryTicket: 'CN-1', links: [link({ kind: 'ticket', key: 'CN-1', source: 'branch', state: 'Released', category: 'done' })] });
    expect(suggestCleanup([c], cfg, NOW)[0]?.reasons).toEqual(['ticket_done']);
  });

  it('suggests idle tabs after the configured hours and sorts by memory', () => {
    const out = suggestCleanup(
      [card({ id: 'small', lastAt: NOW - 30 * HOUR }), card({ id: 'big', lastAt: NOW - 72 * HOUR, tab: { ref: 'w2', windowRef: 'w', title: 't', memoryBytes: 900e6 } })],
      cfg,
      NOW,
    );
    expect(out.map((s) => s.sessionId)).toEqual(['big', 'small']);
    expect(out[0]?.detail).toEqual(['Idle 3d']);
    expect(suggestCleanup([card({ lastAt: NOW - 30 * HOUR })], { ...cfg, idleHours: 0 }, NOW)).toEqual([]);
  });
});
