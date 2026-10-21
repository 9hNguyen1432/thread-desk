import type { DB } from '../db.js';

/**
 * Working time is estimated from message timestamps: the gap between two consecutive messages
 * counts when it is short enough that someone was plausibly working, and is dropped otherwise.
 */
export function activeMinutes(timestamps: number[], idleGapMinutes: number): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const maxGap = idleGapMinutes * 60_000;
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap <= maxGap) total += gap;
  }
  return total / 60_000;
}

export interface SessionActivity {
  sessionId: string;
  minutes: number;
  humanMessages: number;
}

/** Per-session activity within [start, end). Only sessions with at least one message are returned. */
export function activityBetween(db: DB, start: number, end: number, idleGapMinutes: number): Map<string, SessionActivity> {
  const rows = db
    .prepare('select session_id, role, ts from messages where ts >= ? and ts < ? order by session_id, ts')
    .all(start, end) as { session_id: string; role: string; ts: number }[];
  const bySession = new Map<string, { ts: number[]; human: number }>();
  for (const r of rows) {
    const entry = bySession.get(r.session_id) ?? { ts: [], human: 0 };
    entry.ts.push(r.ts);
    if (r.role === 'user') entry.human += 1;
    bySession.set(r.session_id, entry);
  }
  const out = new Map<string, SessionActivity>();
  for (const [sessionId, e] of bySession) {
    out.set(sessionId, { sessionId, minutes: activeMinutes(e.ts, idleGapMinutes), humanMessages: e.human });
  }
  return out;
}
