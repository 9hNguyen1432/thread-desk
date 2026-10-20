import { describe, expect, it } from 'vitest';
import { extractLinks, linkFromQuery, ticketPrefixCandidates, ticketRegex } from '../src/links.js';

const re = ticketRegex(['ENG', 'APP']);

describe('extractLinks', () => {
  it('normalizes GitHub PRs and issues', () => {
    const links = extractLinks('see https://github.com/Acme-Org/Web-API/pull/4360 and https://github.com/a/b/issues/9', null);
    expect(links).toEqual([
      { kind: 'pr', key: 'acme-org/web-api#4360', url: 'https://github.com/Acme-Org/Web-API/pull/4360' },
      { kind: 'issue', key: 'a/b#9', url: 'https://github.com/a/b/issues/9' },
    ]);
  });

  it('groups Slack thread replies under the thread root', () => {
    const root = extractLinks('https://acme.slack.com/archives/C0AB12/p1729400000123456', null)[0];
    const reply = extractLinks('https://acme.slack.com/archives/C0AB12/p1729400999000001?thread_ts=1729400000.123456&cid=C0AB12', null)[0];
    expect(root?.key).toBe('acme/C0AB12/1729400000.123456');
    expect(reply?.key).toBe(root?.key);
  });

  it('extracts Figma file keys from all URL kinds', () => {
    for (const kind of ['design', 'file', 'proto', 'board']) {
      const link = extractLinks(`https://www.figma.com/${kind}/AbCdEfGhIjKlMnOp/Name?node-id=1-2`, null)[0];
      expect(link).toMatchObject({ kind: 'figma', key: 'AbCdEfGhIjKlMnOp' });
    }
  });

  it('only matches configured ticket prefixes', () => {
    const keys = extractLinks('ENG-1442 and app-15022, not UTF-8, SHA-256 or ISO-8601 or XENG-12', re).map((l) => l.key);
    expect(keys).toEqual(['ENG-1442', 'APP-15022']);
  });

  it('finds tickets inside branch names', () => {
    expect(extractLinks('feat/eng-1462-checkout', re)).toEqual([{ kind: 'ticket', key: 'ENG-1462', url: null }]);
  });

  it('reads Linear issue URLs as tickets without configuration', () => {
    expect(extractLinks('https://linear.app/acme/issue/ENG-42/some-title', null)[0]).toMatchObject({ kind: 'ticket', key: 'ENG-42' });
  });

  it('deduplicates repeated mentions', () => {
    expect(extractLinks('ENG-1 ENG-1 ENG-1', re)).toHaveLength(1);
  });

  it('works when the same regex is reused across calls', () => {
    expect(extractLinks('ENG-5', re)).toHaveLength(1);
    expect(extractLinks('ENG-6', re)).toHaveLength(1);
  });
});

describe('ticketRegex', () => {
  it('returns null without valid keys', () => {
    expect(ticketRegex([])).toBeNull();
    expect(ticketRegex(['bad key', '1X'])).toBeNull();
  });
});

describe('ticketPrefixCandidates', () => {
  it('suggests uppercase prefixes and skips common false positives', () => {
    expect(ticketPrefixCandidates('ENG-1442, OPS-7, UTF-8, SHA-256, eng-5')).toEqual(['ENG', 'OPS']);
  });
});

describe('linkFromQuery', () => {
  it('recognizes bare keys, URLs and owner/repo#n', () => {
    expect(linkFromQuery('eng-1442', null)).toEqual({ kind: 'ticket', key: 'ENG-1442', url: null });
    expect(linkFromQuery('https://github.com/a/b/pull/3', null)?.key).toBe('a/b#3');
    expect(linkFromQuery('A/B#3', null)?.key).toBe('a/b#3');
  });

  it('returns null for free text', () => {
    expect(linkFromQuery('billing retry', null)).toBeNull();
    expect(linkFromQuery('hello', null)).toBeNull();
  });
});
