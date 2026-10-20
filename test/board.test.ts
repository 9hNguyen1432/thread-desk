import { describe, expect, it } from 'vitest';
import { badgeFor, closeBlocker, deriveColumn, isLive, liveStatus } from '../src/board.js';
import type { AgentInfo } from '../src/live/agents.js';
import type { Tab } from '../src/terminal/types.js';

function agent(over: Partial<AgentInfo>): AgentInfo {
  return { sessionId: 's', pid: 1, kind: 'interactive', status: 'idle', state: null, waitingFor: null, name: null, cwd: null, startedAt: null, ...over };
}

function tab(over: Partial<Tab>): Tab {
  return { ref: 'workspace:1', windowRef: 'window:1', title: 't', cwd: null, memoryBytes: 0, cpuPercent: 0, claudePid: 1, agentStatus: null, closeBlock: null, ...over };
}

describe('liveStatus', () => {
  it('is null when nothing is running', () => {
    expect(liveStatus(undefined, undefined, undefined)).toBeNull();
    expect(liveStatus(undefined, tab({ claudePid: null }), undefined)).toBeNull();
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
  it('allows closing only on a positive idle signal', () => {
    expect(closeBlocker(agent({ status: 'idle' }), tab({}), 'idle', [])).toBeNull();
    expect(closeBlocker(agent({ status: 'idle' }), tab({ agentStatus: 'needs_you' }), 'needs_you', [])).toBeNull();
    expect(closeBlocker(undefined, tab({ claudePid: null }), null, [])).toBeNull();
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
