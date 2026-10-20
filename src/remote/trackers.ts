import { run, runJson } from '../exec.js';

export type Category = 'open' | 'todo' | 'in_progress' | 'done';

export interface RemoteItem {
  state: string;
  category: Category;
  title: string | null;
  url: string | null;
  description?: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${new URL(url).host} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// GitHub via the gh CLI so the user's existing auth is reused.

export async function ghAvailable(): Promise<boolean> {
  try {
    await run('gh', ['auth', 'status'], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

export async function githubPr(url: string): Promise<RemoteItem> {
  const pr = await runJson<{ state: string; title: string; url: string }>('gh', ['pr', 'view', url, '--json', 'state,title,url'], {
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const state = pr.state.toUpperCase();
  return { state, category: state === 'OPEN' ? 'open' : 'done', title: pr.title, url: pr.url };
}

export async function githubIssue(url: string): Promise<RemoteItem> {
  const issue = await runJson<{ state: string; title: string; url: string; body: string }>(
    'gh',
    ['issue', 'view', url, '--json', 'state,title,url,body'],
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  const state = issue.state.toUpperCase();
  return { state, category: state === 'OPEN' ? 'todo' : 'done', title: issue.title, url: issue.url, description: issue.body };
}

// Jira Cloud REST v3 with an API token from the environment.

export interface JiraCreds {
  site: string;
  email: string;
  token: string;
}

export function jiraCreds(site: string): JiraCreds | null {
  const email = process.env.THREAD_DESK_JIRA_EMAIL;
  const token = process.env.THREAD_DESK_JIRA_TOKEN;
  const host = (process.env.THREAD_DESK_JIRA_SITE ?? site).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!email || !token || !host) return null;
  return { site: host, email, token };
}

function jiraHeaders(c: JiraCreds): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`,
    Accept: 'application/json',
  };
}

type Adf = { type?: string; text?: string; content?: Adf[] };

export function adfToText(node: Adf | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join('');
  const block = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type ?? '');
  return block ? inner + '\n' : inner;
}

export function jiraCategory(key: string | undefined): Category {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

export async function jiraIssue(c: JiraCreds, key: string): Promise<RemoteItem> {
  const issue = await fetchJson<{
    fields: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } }; description?: Adf | null };
  }>(`https://${c.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description`, {
    headers: jiraHeaders(c),
  });
  return {
    state: issue.fields.status?.name ?? 'Unknown',
    category: jiraCategory(issue.fields.status?.statusCategory?.key),
    title: issue.fields.summary ?? null,
    url: `https://${c.site}/browse/${key}`,
    description: adfToText(issue.fields.description).trim() || null,
  };
}

export async function jiraComment(c: JiraCreds, key: string, text: string): Promise<void> {
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: text
        .split(/\n{2,}/)
        .map((para) => para.split('\n').filter((line) => line.trim()))
        .filter((lines) => lines.length > 0)
        .map((lines) => ({
          type: 'paragraph',
          content: lines.flatMap((line, i) =>
            i === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }],
          ),
        })),
    },
  };
  await fetchJson(`https://${c.site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { ...jiraHeaders(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Linear GraphQL with a personal API key.

export function linearKey(): string | null {
  return process.env.THREAD_DESK_LINEAR_KEY || null;
}

export function linearCategory(type: string | undefined): Category {
  if (type === 'started') return 'in_progress';
  if (type === 'completed' || type === 'canceled' || type === 'duplicate') return 'done';
  return 'todo';
}

export async function linearIssue(apiKey: string, key: string): Promise<RemoteItem> {
  const res = await fetchJson<{
    data?: { issue?: { title: string; url: string; description: string | null; state: { name: string; type: string } } };
    errors?: { message: string }[];
  }>('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: String!) { issue(id: $id) { title url description state { name type } } }',
      variables: { id: key },
    }),
  });
  const issue = res.data?.issue;
  if (!issue) throw new Error(res.errors?.[0]?.message ?? `Linear issue ${key} not found`);
  return {
    state: issue.state.name,
    category: linearCategory(issue.state.type),
    title: issue.title,
    url: issue.url,
    description: issue.description,
  };
}

// Slack Web API with a user or bot token.

export function slackToken(): string | null {
  return process.env.THREAD_DESK_SLACK_TOKEN || null;
}

export function parseSlackKey(key: string): { channel: string; ts: string } | null {
  const m = /^[\w-]+\/([A-Z0-9]+)\/(\d{10}\.\d{6})$/.exec(key);
  return m ? { channel: m[1]!, ts: m[2]! } : null;
}

export async function slackThread(token: string, channel: string, ts: string): Promise<string> {
  const res = await fetchJson<{ ok: boolean; error?: string; messages?: { text?: string }[] }>(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}&limit=30`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Slack: ${res.error ?? 'unknown error'}`);
  return (res.messages ?? []).map((m) => m.text ?? '').filter(Boolean).join('\n\n');
}

export async function slackReply(token: string, channel: string, ts: string, text: string): Promise<void> {
  const res = await fetchJson<{ ok: boolean; error?: string }>('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, thread_ts: ts, text }),
  });
  if (!res.ok) throw new Error(`Slack: ${res.error ?? 'unknown error'}`);
}
