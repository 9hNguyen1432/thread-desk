import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_LABEL_RULES, DEFAULT_LABELS, type LabelRule } from './labels.js';

export type OnDone = 'ask' | 'close' | 'keep';

export const TERMINAL_CHOICES = ['auto', 'cmux', 'tmux', 'kitty', 'none'] as const;
export type TerminalChoice = (typeof TERMINAL_CHOICES)[number];

export interface OtherAgentConfig {
  enabled: boolean;
  /** Where the agent keeps its data; empty means its default location. */
  home: string;
  resumeCommand: string;
}

export interface Config {
  port: number;
  claudeDir: string;
  claudeBin: string;
  cmuxBin: string;
  tmuxBin: string;
  kittyBin: string;
  terminal: TerminalChoice;
  pollIntervalMs: number;
  /** Resume command for Claude Code sessions. */
  resumeCommand: string;
  agents: {
    codex: OtherAgentConfig;
    pi: OtherAgentConfig;
    copilot: OtherAgentConfig;
  };
  onDone: OnDone;
  cleanup: {
    idleHours: number;
    prClosed: boolean;
    markedDone: boolean;
    ticketDone: boolean;
  };
  links: {
    ticketKeys: string[];
  };
  trackers: {
    jira: { site: string; keys: string[] };
    linear: { keys: string[] };
  };
  recap: {
    enabled: boolean;
    model: string;
    minNewMessages: number;
    dailyCap: number;
  };
  start: {
    worktreeDir: string;
    branch: string;
    prompt: string;
  };
  labels: {
    names: string[];
    rules: LabelRule[];
    /** Ask Claude Haiku to label recent threads that no rule matches. */
    ai: boolean;
  };
  ask: {
    model: string;
    templates: { name: string; prompt: string }[];
  };
  day: {
    /** Local hour at which a new day begins, so late-night work counts for the day before. */
    startHour: number;
    /** Gaps between messages longer than this are not counted as working time. */
    idleGapMinutes: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  port: 4545,
  claudeDir: join(homedir(), '.claude'),
  claudeBin: 'claude',
  cmuxBin: 'cmux',
  tmuxBin: 'tmux',
  kittyBin: 'kitten',
  terminal: 'auto',
  pollIntervalMs: 4000,
  resumeCommand: 'claude --resume {sessionId}',
  agents: {
    codex: { enabled: true, home: '', resumeCommand: 'codex resume {sessionId}' },
    pi: { enabled: true, home: '', resumeCommand: 'pi --session {sessionId}' },
    copilot: { enabled: true, home: '', resumeCommand: 'copilot --resume={sessionId}' },
  },
  onDone: 'ask',
  cleanup: { idleHours: 24, prClosed: true, markedDone: true, ticketDone: true },
  links: { ticketKeys: [] },
  trackers: { jira: { site: '', keys: [] }, linear: { keys: [] } },
  recap: { enabled: false, model: 'haiku', minNewMessages: 6, dailyCap: 60 },
  start: {
    worktreeDir: '{repoParent}/{repoName}-{slug}',
    branch: 'feat/{key}-{slug}',
    prompt: 'Work on {key}: {title}\n\n{url}\n\n{description}',
  },
  labels: { names: DEFAULT_LABELS, rules: DEFAULT_LABEL_RULES, ai: false },
  ask: {
    model: 'sonnet',
    templates: [
      {
        name: 'Support case summary',
        prompt:
          'Summarize this support case for the team in at most 8 lines: who was affected, what they reported, the root cause, what was done or changed, and anything the support bot or docs got wrong. Do not change any files.',
      },
      {
        name: 'Lessons for the support bot',
        prompt:
          'List what a support assistant should know after this thread: facts, how to check them, and any answer that was wrong before and the correct one. Be concrete and short. Do not change any files.',
      },
      {
        name: 'Handoff status',
        prompt: 'Write a short handoff: goal, what is done, what is left, open questions, links to PRs and tickets. Do not change any files.',
      },
    ],
  },
  day: { startHour: 4, idleGapMinutes: 20 },
};

/** Data directories of the other agents, honouring the environment variables each one documents. */
export function agentHome(config: Config, kind: 'codex' | 'pi' | 'copilot'): string {
  const configured = config.agents[kind].home.trim();
  if (configured) return configured;
  switch (kind) {
    case 'codex':
      return process.env.CODEX_HOME || join(homedir(), '.codex');
    case 'pi':
      return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    case 'copilot':
      return join(homedir(), '.copilot');
  }
}

export function dataDir(override?: string): string {
  return override ?? process.env.THREAD_DESK_HOME ?? join(homedir(), '.thread-desk');
}

export function ensureDataDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeConfig<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) continue;
    const current = (base as Record<string, unknown>)[key];
    if (isPlainObject(current)) out[key] = mergeConfig(current, value);
    else if (value !== undefined && typeof value === typeof current) out[key] = value;
  }
  return out as T;
}

export function configPath(dir: string): string {
  return join(dir, 'config.json');
}

export function loadConfig(dir: string): Config {
  const file = configPath(dir);
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return mergeConfig(structuredClone(DEFAULT_CONFIG), raw);
}

export function saveConfig(dir: string, config: Config): void {
  writeFileSync(configPath(dir), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function readOrCreateSecret(dir: string, name: string): string {
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(24).toString('hex');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}
