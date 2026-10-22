import type { AgentKind, Column, TerminalName } from './types';

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

export const COLUMN_LABEL: Record<Column, string> = {
  needs_you: 'Needs you',
  running: 'Running',
  idle: 'Idle',
  paused: 'Paused',
  waiting_others: 'Waiting on others',
  done: 'Done',
  archived: 'Archived',
};

export const COLUMN_COLOR: Record<Column, string> = {
  needs_you: 'var(--st-needs)',
  running: 'var(--st-running)',
  idle: 'var(--st-idle)',
  paused: 'var(--st-paused)',
  waiting_others: 'var(--st-waiting)',
  done: 'var(--st-done)',
  archived: 'var(--st-archived)',
};

export const COLUMN_HINT: Record<Column, string> = {
  needs_you: 'The agent finished or asked something. Your move.',
  running: 'An agent is working right now.',
  idle: 'Open in a tab, nothing pending.',
  paused: 'No tab open. Resume any time.',
  waiting_others: 'Blocked on someone else. Drop a thread here.',
  done: 'Finished. Drop a thread here to close it out.',
  archived: 'Out of the way, still searchable.',
};

export function prLabel(key: string): string {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  return m ? `${m[2]}#${m[3]}` : key;
}

export function minutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${h}h${String(rest).padStart(2, '0')}` : `${h}h`;
}

export function dayLabel(day: string, today?: string): string {
  if (today && day === today) return 'Today';
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + n, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const LABEL_PALETTE = ['var(--st-needs)', 'var(--st-running)', 'var(--danger)', 'var(--st-waiting)', 'var(--st-done)', 'var(--st-idle)'];
const KNOWN_LABELS: Record<string, string> = {
  Support: LABEL_PALETTE[0]!,
  Feature: LABEL_PALETTE[1]!,
  Bug: LABEL_PALETTE[2]!,
  Investigation: LABEL_PALETTE[3]!,
  Review: LABEL_PALETTE[4]!,
  Ops: LABEL_PALETTE[5]!,
};

export function labelColor(name: string): string {
  if (KNOWN_LABELS[name]) return KNOWN_LABELS[name]!;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_PALETTE[h % LABEL_PALETTE.length]!;
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  copilot: 'Copilot',
};

/** What one open terminal session is called in each terminal. */
export function tabNoun(terminal: TerminalName, plural = false): string {
  const noun = terminal === 'tmux' ? 'tmux window' : terminal === 'kitty' ? 'kitty tab' : terminal === 'cmux' ? 'cmux tab' : 'terminal tab';
  return plural ? `${noun}s` : noun;
}
