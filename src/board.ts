import type { AgentInfo } from './live/agents.js';
import type { LiveStatus, Tab } from './terminal/types.js';

export type Lifecycle = 'active' | 'waiting_others' | 'done' | 'archived';
export type Column = LiveStatus | 'paused' | 'waiting_others' | 'done' | 'archived';

export const LIFECYCLES: readonly Lifecycle[] = ['active', 'waiting_others', 'done', 'archived'];

export interface HookState {
  status: LiveStatus;
  at: number;
  lastAssistantMessage: string | null;
}

export function isLive(agent: AgentInfo | undefined, tab: Tab | undefined): boolean {
  if (tab?.claudePid) return true;
  if (!agent) return false;
  if (agent.kind === 'background') return agent.state === 'working' || agent.state === 'blocked';
  return agent.pid !== null;
}

/** Live status precedence: an explicit question beats activity, activity beats terminal and hook hints. */
export function liveStatus(agent: AgentInfo | undefined, tab: Tab | undefined, hook: HookState | undefined): LiveStatus | null {
  if (!isLive(agent, tab)) return null;
  if (agent?.status === 'waiting' || agent?.state === 'blocked') return 'needs_you';
  if (agent?.status === 'busy' || agent?.state === 'working') return 'running';
  if (tab?.agentStatus) return tab.agentStatus;
  if (hook) return hook.status;
  return 'idle';
}

/**
 * Closing a tab must fail closed: it is only allowed on a positive signal that nothing but an idle
 * Claude session (or an idle shell) lives in the tab and that live status is current.
 */
export function closeBlocker(
  agent: AgentInfo | undefined,
  tab: Tab | undefined,
  live: LiveStatus | null,
  liveErrors: readonly string[],
): string | null {
  if (!tab) return 'No open terminal tab for this thread';
  if (liveErrors.length > 0) return 'Live status is unavailable right now; try again in a moment';
  if (tab.closeBlock) return tab.closeBlock;
  if (live === 'running') return 'Claude is still working in this tab; stop it first';
  if (agent?.status === 'waiting' || agent?.state === 'blocked') return 'Claude is waiting for an answer in this tab';
  // The cmux sidebar alone cannot tell a finished turn from a permission prompt mid-turn.
  if (tab.claudePid !== null && !agent) return 'Cannot tell whether Claude is busy in this tab';
  if (agent && agent.status === null && agent.kind !== 'background') return 'Cannot tell whether Claude is busy in this tab';
  return null;
}

export function deriveColumn(lifecycle: Lifecycle, live: LiveStatus | null): Column {
  if (lifecycle !== 'active') return lifecycle;
  return live ?? 'paused';
}

export function badgeFor(lifecycle: Lifecycle, note: string | null): { text: string; icon: string } | null {
  const trimmed = note?.trim() || null;
  switch (lifecycle) {
    case 'done':
      return { text: 'Done', icon: 'checkmark.circle.fill' };
    case 'archived':
      return { text: 'Archived', icon: 'archivebox.fill' };
    case 'waiting_others':
      return { text: trimmed ? `Waiting: ${trimmed}` : 'Waiting on others', icon: 'hourglass' };
    default:
      return trimmed ? { text: trimmed, icon: 'note.text' } : null;
  }
}
