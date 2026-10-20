import type { Column } from './types';

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
  needs_you: 'Claude finished or asked something. Your move.',
  running: 'Claude is working right now.',
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
