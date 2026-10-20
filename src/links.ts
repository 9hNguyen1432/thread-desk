export type LinkKind = 'pr' | 'issue' | 'ticket' | 'slack' | 'figma';
export type LinkSource = 'pr-link' | 'branch' | 'title' | 'user' | 'assistant';

export interface LinkRef {
  kind: LinkKind;
  key: string;
  url: string | null;
}

export const SOURCE_PRIORITY: Record<LinkSource, number> = {
  'pr-link': 5,
  branch: 4,
  title: 3,
  user: 2,
  assistant: 1,
};

const GITHUB_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gi;
const SLACK_RE = /https?:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(\?[^\s)>\]"'`]*)?/g;
const FIGMA_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board|slides|deck|make)\/([A-Za-z0-9]{10,128})(?:\/[^\s?)>\]"'`]*)?(\?[^\s)>\]"'`]*)?/g;
const LINEAR_RE = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,6})/g;
const PREFIX_CANDIDATE_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![0-9A-Za-z])/g;
const PREFIX_STOPLIST = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'GPT', 'COVID', 'CVE', 'MD', 'IPV']);

export function prKey(owner: string, repo: string, n: string | number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${n}`;
}

function slackTs(p: string): string {
  return `${p.slice(0, 10)}.${p.slice(10)}`;
}

export function ticketRegex(keys: string[]): RegExp | null {
  const clean = keys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]{0,9}$/.test(k));
  if (clean.length === 0) return null;
  return new RegExp(`(?<![A-Za-z0-9])(${clean.join('|')})-(\\d{1,6})(?![0-9])`, 'gi');
}

export function extractLinks(text: string, ticketRe: RegExp | null): LinkRef[] {
  const found = new Map<string, LinkRef>();
  const add = (ref: LinkRef) => {
    const id = `${ref.kind}:${ref.key}`;
    if (!found.has(id)) found.set(id, ref);
  };

  for (const m of text.matchAll(GITHUB_RE)) {
    const [, owner, repo, type, n] = m as unknown as [string, string, string, string, string];
    const kind: LinkKind = type.toLowerCase() === 'pull' ? 'pr' : 'issue';
    add({ kind, key: prKey(owner, repo, n), url: `https://github.com/${owner}/${repo}/${type.toLowerCase()}/${n}` });
  }

  for (const m of text.matchAll(SLACK_RE)) {
    const [whole, workspace, channel, p, query] = m as unknown as [string, string, string, string, string | undefined];
    const threadTs = query ? new URLSearchParams(query.slice(1)).get('thread_ts') : null;
    const rootTs = threadTs && /^\d{10}\.\d{6}$/.test(threadTs) ? threadTs : slackTs(p);
    add({ kind: 'slack', key: `${workspace}/${channel}/${rootTs}`, url: whole });
  }

  for (const m of text.matchAll(FIGMA_RE)) {
    const [whole, fileKey] = m as unknown as [string, string];
    add({ kind: 'figma', key: fileKey, url: whole });
  }

  for (const m of text.matchAll(LINEAR_RE)) {
    const [whole, key] = m as unknown as [string, string];
    add({ kind: 'ticket', key: key.toUpperCase(), url: whole });
  }

  if (ticketRe) {
    ticketRe.lastIndex = 0;
    for (const m of text.matchAll(ticketRe)) {
      const [, prefix, n] = m as unknown as [string, string, string];
      add({ kind: 'ticket', key: `${prefix.toUpperCase()}-${n}`, url: null });
    }
  }

  return [...found.values()];
}

export function ticketPrefixCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PREFIX_CANDIDATE_RE)) {
    const prefix = m[1]!;
    if (!PREFIX_STOPLIST.has(prefix)) out.add(prefix);
  }
  return [...out];
}

/** Classifies a search query that is a single link or ticket key; null means free text. */
export function linkFromQuery(query: string, ticketRe: RegExp | null): LinkRef | null {
  const q = query.trim();
  if (/\s/.test(q)) return null;
  const links = extractLinks(q, ticketRe);
  if (links.length > 0) return links[0]!;
  const bare = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})$/.exec(q);
  if (bare) return { kind: 'ticket', key: `${bare[1]!.toUpperCase()}-${bare[2]}`, url: null };
  const shortPr = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(q);
  if (shortPr) return { kind: 'pr', key: prKey(shortPr[1]!, shortPr[2]!, shortPr[3]!), url: null };
  return null;
}
