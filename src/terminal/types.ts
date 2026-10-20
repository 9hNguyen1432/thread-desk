export type LiveStatus = 'running' | 'needs_you' | 'idle';

export interface Tab {
  ref: string;
  windowRef: string;
  title: string;
  cwd: string | null;
  memoryBytes: number;
  cpuPercent: number;
  claudePid: number | null;
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
  readonly name: 'cmux' | 'none';
  listTabs(): Promise<Tab[]>;
  /** Fallback when the Claude pid cannot be joined with `claude agents`. */
  sessionIdForTab(tab: Tab): Promise<string | null>;
  focus(tab: Tab): Promise<void>;
  close(tab: Tab): Promise<void>;
  open(opts: OpenOptions): Promise<void>;
  setBadge(tab: Tab, badge: { text: string; icon: string } | null): Promise<void>;
}
