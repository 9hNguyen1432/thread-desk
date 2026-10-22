import { describe, expect, it } from 'vitest';
import { badgeFor, closeBlocker, deriveColumn, isLive, liveStatus } from '../src/board.js';
import type { AgentInfo } from '../src/live/agents.js';
import type { Tab } from '../src/terminal/types.js';

function agent(over: Partial<AgentInfo>): AgentInfo {
  return { sessionId: 's', pid: 1, kind: 'interactive', status: 'idle', state: null, waitingFor: null, name: null, cwd: null, startedAt: null, ...over };
}

function tab(over: Partial<Tab>): Tab {
  return { ref: 'workspace:1', windowRef: 'window:1', title: 't', cwd: null, memoryBytes: 0, cpuPercent: 0, agentPid: 1, agentKind: 'claude', agentStartedAt: null, agentSessionHint: null, agentStatus: null, closeBlock: null, ...over };
}

describe('liveStatus', () => {
  it('is null when nothing is running', () => {
    expect(liveStatus(undefined, undefined, undefined)).toBeNull();
    expect(liveStatus(undefined, tab({ agentPid: null }), undefined)).toBeNull();
    expect(liveStatus(agent({ kind: 'background', pid: null, state: 'done' }), undefined, undefined)).toBeNull();
  });

  it('puts a question above everything else', () => {
    expect(liveStatus(agent({ status: 'waiting' }), tab({ agentStatus: 'running' }), undefined)).toBe('needs_you');
    expect(liveStatus(agent({ kind: 'background', pid: null, state: 'blocked' }), undefined, undefined)).toBe('needs_you');
  });

  it('prefers agent activity, then the terminal, then hooks', () => {
    expect(liveStatus(agent({ status: 'busy' }), tab({ agentStatus: 'needs_you' }), undefined)).toBe('running');
    expect(liveStatus(agent({ status: 'idle' }), tab({ agentStatus: 'needs_you' }), undefined)).toBe('needs_you');
    expect(liveStatus(agent({ status: 'idle' }), undefined, { status: 'needs_you', at: 0, lastAssistantMessage: null })).toBe('needs_you');
    expect(liveStatus(agent({ status: 'idle' }), undefined, undefined)).toBe('idle');
  });

  it('treats a terminal tab with a Claude pid as live', () => {
    expect(isLive(undefined, tab({}))).toBe(true);
  });
});

describe('deriveColumn', () => {
  it('lets the user lifecycle win over live status', () => {
    expect(deriveColumn('done', 'running')).toBe('done');
    expect(deriveColumn('waiting_others', null)).toBe('waiting_others');
  });

  it('falls back to live status or paused', () => {
    expect(deriveColumn('active', 'needs_you')).toBe('needs_you');
    expect(deriveColumn('active', null)).toBe('paused');
  });
});

describe('badgeFor', () => {
  it('describes the lifecycle and note', () => {
    expect(badgeFor('done', null)?.text).toBe('Done');
    expect(badgeFor('waiting_others', 'Sam')?.text).toBe('Waiting: Sam');
    expect(badgeFor('active', '  ')).toBeNull();
    expect(badgeFor('active', 'retest after deploy')?.text).toBe('retest after deploy');
  });
});

describe('closeBlocker', () => {
  it('lets other agents close only after a quiet transcript and with low CPU', () => {
    const codex = tab({ agentKind: 'codex', agentPid: 9 });
    const now = 10_000_000;
    expect(closeBlocker(undefined, codex, 'idle', [], now - 11 * 60_000, now)).toBeNull();
    expect(closeBlocker(undefined, codex, 'idle', [], now - 2 * 60_000, now)).toMatch(/Codex was active in the last 10 minutes/);
    expect(closeBlocker(undefined, codex, 'idle', [], null, now)).toMatch(/may still be working/);
    expect(closeBlocker(undefined, { ...codex, cpuPercent: 40 }, 'idle', [], now - 60 * 60_000, now)).toMatch(/using CPU/);
    expect(closeBlocker(undefined, { ...codex, closeBlock: 'npm is running in this tab' }, 'idle', [], 0, now)).toMatch(/npm/);
    // A guessed match may belong to another tab's session, so it never allows closing.
    expect(closeBlocker(undefined, codex, 'idle', [], now - 60 * 60_000, now, true)).toMatch(/Cannot tell for sure which session/);
  });

  it('allows closing only on a positive idle signal', () => {
    expect(closeBlocker(agent({ status: 'idle' }), tab({}), 'idle', [])).toBeNull();
    expect(closeBlocker(agent({ status: 'idle' }), tab({ agentStatus: 'needs_you' }), 'needs_you', [])).toBeNull();
    expect(closeBlocker(undefined, tab({ agentPid: null }), null, [])).toBeNull();
  });

  it('blocks when anything is uncertain or busy', () => {
    expect(closeBlocker(agent({ status: 'idle' }), tab({}), 'idle', ['claude agents: timeout'])).toMatch(/unavailable/);
    expect(closeBlocker(agent({ status: 'busy' }), tab({}), 'running', [])).toMatch(/working/);
    expect(closeBlocker(agent({ status: 'waiting' }), tab({}), 'needs_you', [])).toMatch(/waiting for an answer/);
    expect(closeBlocker(undefined, tab({ agentStatus: null }), 'idle', [])).toMatch(/Cannot tell/);
    expect(closeBlocker(undefined, tab({ agentStatus: 'needs_you' }), 'needs_you', [])).toMatch(/Cannot tell/);
    expect(closeBlocker(agent({ status: null }), tab({}), 'idle', [])).toMatch(/Cannot tell/);
    expect(closeBlocker(agent({ status: 'idle' }), tab({ closeBlock: 'npm is running in this tab' }), 'idle', [])).toBe('npm is running in this tab');
    expect(closeBlocker(agent({}), undefined, 'idle', [])).toMatch(/No open/);
  });
});
