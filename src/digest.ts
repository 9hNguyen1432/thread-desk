import type { DB } from './db.js';
import type { Card } from './store.js';

export interface Digest {
  from: number;
  to: number;
  done: Card[];
  active: Card[];
  waiting: Card[];
  prs: { key: string; url: string | null; state: string | null; title: string | null; sessionTitle: string }[];
  tickets: string[];
  markdown: string;
}

function day(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bullet(card: Card): string {
  const ticket = card.primaryTicket ? `[${card.primaryTicket}] ` : '';
  const note = card.note ? ` (${card.note})` : '';
  return `- ${ticket}${card.title}${note}`;
}

export function buildDigest(db: DB, cards: Card[], from: number, to: number): Digest {
  const inRange = (ts: number | null) => ts !== null && ts >= from && ts < to;
  const done = cards.filter((c) => c.lifecycle === 'done' && inRange(c.doneAt));
  const active = cards.filter((c) => c.lifecycle !== 'done' && inRange(c.lastHumanAt));
  const waiting = cards.filter((c) => c.column === 'needs_you' || c.column === 'waiting_others');

  const byId = new Map(cards.map((c) => [c.id, c]));
  const prRows = db
    .prepare(
      `select l.session_id, l.key, l.url, r.state, r.title from links l
       left join remote_status r on r.kind = l.kind and r.key = l.key
       where l.kind = 'pr' and l.source = 'pr-link' and l.first_at >= ? and l.first_at < ?
       order by l.first_at`,
    )
    .all(from, to) as { session_id: string; key: string; url: string | null; state: string | null; title: string | null }[];
  const prs = prRows.map((r) => ({
    key: r.key,
    url: r.url,
    state: r.state,
    title: r.title,
    sessionTitle: byId.get(r.session_id)?.title ?? r.session_id,
  }));

  const tickets = [...new Set([...done, ...active].map((c) => c.primaryTicket).filter((t): t is string => Boolean(t)))];

  const lines: string[] = [];
  const range = day(from) === day(to - 1) ? day(from) : `${day(from)} → ${day(to - 1)}`;
  lines.push(`*Thread Desk digest: ${range}*`, '');
  if (done.length) lines.push(`*Done (${done.length})*`, ...done.map(bullet), '');
  if (prs.length) {
    lines.push(`*PRs (${prs.length})*`);
    for (const pr of prs) lines.push(`- ${pr.url ?? pr.key}${pr.state ? ` (${pr.state.toLowerCase()})` : ''}${pr.title ? `: ${pr.title}` : ''}`);
    lines.push('');
  }
  if (active.length) lines.push(`*In progress (${active.length})*`, ...active.map(bullet), '');
  if (waiting.length) lines.push(`*Waiting (${waiting.length})*`, ...waiting.map(bullet), '');
  if (tickets.length) lines.push(`*Tickets touched:* ${tickets.join(', ')}`);
  if (lines.length === 2) lines.push('_No activity in this range._');

  return { from, to, done, active, waiting, prs, tickets, markdown: lines.join('\n').trim() + '\n' };
}
