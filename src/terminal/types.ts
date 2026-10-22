import type { AgentKind } from '../agents.js';

export type LiveStatus = 'running' | 'needs_you' | 'idle';

export interface Tab {
  ref: string;
  windowRef: string;
  title: string;
  cwd: string | null;
  memoryBytes: number;
  cpuPercent: number;
  /** The coding agent in the foreground of this tab, if any. */
  agentPid: number | null;
  agentKind: AgentKind | null;
  /** When that agent process started, used to tell which of its sessions it is running. */
  agentStartedAt: number | null;
  /** A session id named on the agent's command line, e.g. `codex resume <id>`. */
  agentSessionHint: string | null;
  agentStatus: LiveStatus | null;
  /** Why closing this tab could kill something other than an idle Claude session; null when it is safe. */
  closeBlock: string | null;
}

export interface OpenOptions {
  cwd: string;
  title: string;
  command: string;
}

export interface TerminalAdapter {
  readonly name: 'cmux' | 'tmux' | 'kitty' | 'none';
  listTabs(): Promise<Tab[]>;
  /** The session a tab is running, when the terminal records it (cmux resume bindings). */
  sessionIdForTab(tab: Tab): Promise<string | null>;
  focus(tab: Tab): Promise<void>;
  close(tab: Tab): Promise<void>;
  open(opts: OpenOptions): Promise<void>;
  setBadge(tab: Tab, badge: { text: string; icon: string } | null): Promise<void>;
}
