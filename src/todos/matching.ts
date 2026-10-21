import type { DB } from '../db.js';
import { extractLinks, type LinkKind, type LinkRef } from '../links.js';
import type { Searcher } from '../search.js';
import type { TodoRow } from './store.js';

/** Link sources that come from the user (branch, title, prompts, created PRs), not from Claude's replies. */
const USER_SOURCES = new Set(['pr-link', 'branch', 'title', 'user']);
/** Stricter set for linking without asking: titles can be written by Claude, so they only suggest. */
const AUTO_SOURCES = new Set(['pr-link', 'branch', 'user']);
/** Only these identify the same piece of work closely enough to link without asking. */
export const AUTO_LINK_KINDS: ReadonlySet<LinkKind> = new Set(['slack', 'ticket', 'pr']);

const KIND_REASON: Record<LinkKind, string> = {
  slack: 'same Slack thread',
  ticket: 'same ticket',
  pr: 'same PR',
  issue: 'same GitHub issue',
  figma: 'same Figma file',
};

const STOPWORDS = new Set(
  'the and for with from that this into have will about after before what when where which while there their them they then than your you are was were been being can could should would just also only some more most other such very cho của và các những với trong không được này đó khi thì là một có để vào lại đã sẽ'.split(
    ' ',
  ),
);

export interface KeyMatch {
  sessionId: string;
  kind: LinkKind;
  key: string;
  fromUser: boolean;
  autoEligible: boolean;
}

export interface Suggestion {
  sessionId: string;
  reason: string;
  score: number;
}

export function todoKeys(todo: Pick<TodoRow, 'title' | 'notes'>, ticketRe: RegExp | null): LinkRef[] {
  return extractLinks(`${todo.title}\n${todo.notes ?? ''}`, ticketRe);
}

/** Sessions that mention any of the given links, with whether the user (not Claude) brought it up. */
export function sessionsSharingKeys(db: DB, keys: LinkRef[]): KeyMatch[] {
  if (keys.length === 0) return [];
  const where = keys.map(() => '(kind = ? and key = ?)').join(' or ');
  const rows = db
    .prepare(`select session_id, kind, key, source from links where hidden = 0 and (${where})`)
    .all(...keys.flatMap((k) => [k.kind, k.key])) as { session_id: string; kind: LinkKind; key: string; source: string }[];
  const best = new Map<string, KeyMatch>();
  for (const r of rows) {
    const match: KeyMatch = {
      sessionId: r.session_id,
      kind: r.kind,
      key: r.key,
      fromUser: USER_SOURCES.has(r.source),
      autoEligible: AUTO_SOURCES.has(r.source) && AUTO_LINK_KINDS.has(r.kind),
    };
    const prev = best.get(r.session_id);
    const rank = (m: KeyMatch) => (m.autoEligible ? 2 : 0) + (m.fromUser ? 1 : 0);
    if (!prev || rank(match) > rank(prev)) best.set(r.session_id, match);
  }
  return [...best.values()];
}

/** Distinctive words of a todo for full-text matching; links and ticket keys are matched separately. */
export function significantWords(text: string): string[] {
  const withoutLinks = text.replace(/https?:\/\/\S+/g, ' ').replace(/\b[A-Za-z][A-Za-z0-9]{0,9}-\d+\b/g, ' ');
  const words = withoutLinks
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 8);
}

export interface SuggestInput {
  todo: TodoRow;
  keys: LinkRef[];
  exclude: Set<string>;
  titles: Map<string, string>;
  recentSince: number;
  lastAt: Map<string, number>;
}

/**
 * Ranks existing threads for a todo. Shared links rank first; otherwise words of the todo must
 * match the thread's title or several of its messages, which keeps one-word coincidences out.
 */
export function suggestThreads(db: DB, searcher: Searcher, input: SuggestInput, limit = 5): Suggestion[] {
  const out = new Map<string, Suggestion>();
  const put = (s: Suggestion) => {
    if (input.exclude.has(s.sessionId)) return;
    if ((input.lastAt.get(s.sessionId) ?? 0) < input.recentSince) return;
    const prev = out.get(s.sessionId);
    if (!prev || s.score > prev.score) out.set(s.sessionId, s);
  };

  for (const m of sessionsSharingKeys(db, input.keys)) {
    put({ sessionId: m.sessionId, reason: `${KIND_REASON[m.kind]} (${m.key.split('/').pop()})`, score: m.fromUser ? 1000 : 600 });
  }

  const words = significantWords(`${input.todo.title} ${input.todo.notes ?? ''}`);
  if (words.length >= 2) {
    for (const [sessionId, title] of input.titles) {
      const titleWords = new Set(significantWords(title));
      const shared = words.filter((w) => titleWords.has(w)).length;
      if (shared >= 2) put({ sessionId, reason: 'similar title', score: 400 + shared * 10 });
    }
    // Require two different words to co-occur in the conversation, not just one common term.
    const pairs: [string, string][] = [];
    for (let i = 0; i < words.length && pairs.length < 6; i++) for (let j = i + 1; j < words.length && pairs.length < 6; j++) pairs.push([words[i]!, words[j]!]);
    const counts = new Map<string, number>();
    for (const [a, b] of pairs) {
      for (const hit of searcher.search(`${a} ${b}`, null, new Map(), 20)) {
        if (hit.matchedBy === 'text') counts.set(hit.sessionId, (counts.get(hit.sessionId) ?? 0) + 1);
      }
    }
    for (const [sessionId, n] of counts) {
      if (n >= 2) put({ sessionId, reason: 'talks about the same things', score: 100 + n * 20 });
    }
  }

  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Normalizes prompts so a launched prompt can be recognized as the first message of a new session. */
export function promptFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
}
