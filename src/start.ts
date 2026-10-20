import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Config } from './config.js';
import { run } from './exec.js';
import { linkFromQuery } from './links.js';
import type { RemoteStatus } from './remote/status.js';
import { githubIssue, parseSlackKey, slackThread, slackToken } from './remote/trackers.js';
import { truncate } from './transcript/parse.js';

export interface StartDraft {
  key: string | null;
  title: string;
  url: string | null;
  description: string;
  branch: string;
  prompt: string;
  warnings: string[];
}

export interface LaunchRequest {
  cwd: string;
  title: string;
  prompt: string;
  worktree: boolean;
  branch: string;
  key: string | null;
}

export function slugify(text: string, max = 40): string {
  return text
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}

export function branchName(template: string, key: string | null, title: string): string {
  const slug = slugify(title, 30) || 'task';
  const filled = key ? fillTemplate(template, { key: key.toLowerCase(), slug }) : fillTemplate(template.replace(/\{key\}-?/, ''), { slug });
  return filled.replace(/\/{2,}/g, '/').replace(/-{2,}/g, '-');
}

export async function draftStart(input: string, cfg: Config, remote: RemoteStatus): Promise<StartDraft> {
  const warnings: string[] = [];
  const link = linkFromQuery(input, null);
  let key: string | null = null;
  let title = input.trim();
  let url: string | null = null;
  let description = '';

  try {
    if (link?.kind === 'ticket') {
      key = link.key;
      url = link.url;
      const item = await remote.fetchItem({ kind: 'ticket', key: link.key, url: link.url });
      if (item) {
        title = item.title ?? key;
        url = item.url ?? url;
        description = item.description ?? '';
      } else {
        title = key;
        warnings.push(`No tracker configured for ${key}; fill in the details yourself.`);
      }
    } else if (link?.kind === 'issue' && link.url) {
      const item = await githubIssue(link.url);
      key = link.key;
      title = item.title ?? link.key;
      url = link.url;
      description = item.description ?? '';
    } else if (link?.kind === 'slack') {
      url = link.url;
      const token = slackToken();
      const ref = parseSlackKey(link.key);
      if (token && ref) {
        description = await slackThread(token, ref.channel, ref.ts);
        title = truncate(description.split('\n')[0] ?? 'Slack thread', 80);
      } else {
        title = 'Slack thread';
        warnings.push('Set THREAD_DESK_SLACK_TOKEN to pull the thread text automatically.');
      }
    } else if (link?.url) {
      url = link.url;
      title = link.key;
    }
  } catch (e) {
    warnings.push((e as Error).message);
  }

  description = truncate(description.trim(), 6000);
  const template = key ? cfg.start.prompt : cfg.start.prompt.replace(/\{key\}:?\s*/g, '');
  const prompt = fillTemplate(template, { key: key ?? '', title, url: url ?? '', description })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { key, title, url, description, branch: branchName(cfg.start.branch, key, title), prompt, warnings };
}

const PROMPT_TTL_MS = 7 * 24 * 3_600_000;

function removeOldPrompts(dir: string): void {
  const cutoff = Date.now() - PROMPT_TTL_MS;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file);
    } catch {
      // Another launch may have removed it already.
    }
  }
}

async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface Launched {
  dir: string;
  command: string;
}

/** Prepares the directory (optionally a new worktree) and the shell command that starts Claude there. */
export async function prepareLaunch(req: LaunchRequest, cfg: Config, dataDir: string): Promise<Launched> {
  if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) throw new Error(`Not a directory: ${req.cwd}`);
  let dir = req.cwd;

  if (req.worktree) {
    const top = await gitTopLevel(req.cwd);
    if (!top) throw new Error(`${req.cwd} is not inside a git repository`);
    await run('git', ['check-ref-format', '--branch', req.branch], { cwd: top }).catch(() => {
      throw new Error(`Invalid branch name: ${req.branch}`);
    });
    const slug = slugify(req.key ?? '', 40) || slugify(req.title, 30) || 'task';
    dir = fillTemplate(cfg.start.worktreeDir, { repoParent: dirname(top), repoName: basename(top), slug });
    if (existsSync(dir)) throw new Error(`Worktree path already exists: ${dir}`);
    const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${req.branch}`], { cwd: top })
      .then(() => true)
      .catch(() => false);
    const args = exists ? ['worktree', 'add', dir, req.branch] : ['worktree', 'add', '-b', req.branch, dir];
    await run('git', args, { cwd: top, timeoutMs: 60_000 });
  }

  const promptsDir = join(dataDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
  removeOldPrompts(promptsDir);
  const promptFile = join(promptsDir, `${Date.now()}-${randomBytes(4).toString('hex')}.txt`);
  writeFileSync(promptFile, req.prompt, { mode: 0o600 });
  // `--` keeps a prompt that starts with "-" (a markdown bullet) from being read as an option.
  const command = `${shQuote(cfg.claudeBin)} -n ${shQuote(req.title)} -- "$(cat ${shQuote(promptFile)})"`;
  return { dir, command };
}
