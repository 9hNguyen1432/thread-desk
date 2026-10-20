import type { DB } from './db.js';
import { linkFromQuery, type LinkRef } from './links.js';
import { normalizeForSearch } from './transcript/indexer.js';

export interface SearchHit {
  sessionId: string;
  matchedBy: 'link' | 'title' | 'text';
  score: number;
  snippet: string | null;
  link: LinkRef | null;
}

export interface ParsedQuery {
  text: string;
  project: string | null;
  is: string | null;
}

export function parseQuery(raw: string): ParsedQuery {
  let project: string | null = null;
  let is: string | null = null;
  const rest: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const m = /^(project|is):(.+)$/i.exec(token);
    if (m && m[1]!.toLowerCase() === 'project') project = m[2]!;
    else if (m) is = m[2]!.toLowerCase();
    else if (token) rest.push(token);
  }
  return { text: rest.join(' '), project, is };
}

/** Each token becomes a quoted prefix term, so user input can never break FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const tokens = normalizeForSearch(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function fold(text: string): string {
  return normalizeForSearch(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function makeSnippet(text: string, query: string, radius = 90): string {
  const flat = text.replace(/\s+/g, ' ');
  const folded = fold(flat);
  const terms = fold(query).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  let at = -1;
  for (const term of terms) {
    const i = folded.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, radius * 2);
  // Folding can shift offsets for decomposed input; clamp to stay in range.
  const start = Math.max(0, Math.min(at, flat.length) - radius);
  const end = Math.min(flat.length, start + radius * 2);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export class Searcher {
  constructor(private readonly db: DB) {}

  search(raw: string, ticketRe: RegExp | null, titles: Map<string, string>, limit = 40): SearchHit[] {
    const q = parseQuery(raw);
    const hits = new Map<string, SearchHit>();
    const put = (hit: SearchHit) => {
      const prev = hits.get(hit.sessionId);
      if (!prev || hit.score > prev.score) hits.set(hit.sessionId, hit);
    };
    if (!q.text) return [];

    const link = linkFromQuery(q.text, ticketRe);
    if (link) {
      const rows = this.db
        .prepare(
          `select session_id, mentions, source from links
           where kind = ? and key = ? and hidden = 0 order by mentions desc`,
        )
        .all(link.kind, link.key) as { session_id: string; mentions: number; source: string }[];
      for (const r of rows) {
        const sourceBoost = r.source === 'assistant' ? 0 : 50;
        put({ sessionId: r.session_id, matchedBy: 'link', score: 1000 + sourceBoost + r.mentions, snippet: null, link });
      }
    }

    const needle = fold(q.text);
    for (const [id, title] of titles) {
      if (fold(title).includes(needle)) put({ sessionId: id, matchedBy: 'title', score: 500, snippet: null, link: null });
    }

    const fts = ftsQuery(q.text);
    if (fts) {
      const rows = this.db
        .prepare(
          `select m.session_id, m.text, bm25(messages_fts) as rank
           from messages_fts join messages m on m.id = messages_fts.rowid
           where messages_fts match ? order by rank limit 2000`,
        )
        .all(fts) as { session_id: string; text: string; rank: number }[];
      for (const r of rows) {
        // bm25 is negative; more negative is better.
        const score = Math.min(400, -r.rank * 10);
        if (!hits.has(r.session_id) || hits.get(r.session_id)!.score < score) {
          put({ sessionId: r.session_id, matchedBy: 'text', score, snippet: makeSnippet(r.text, q.text), link: null });
        } else if (!hits.get(r.session_id)!.snippet) {
          hits.get(r.session_id)!.snippet = makeSnippet(r.text, q.text);
        }
      }
    }

    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
