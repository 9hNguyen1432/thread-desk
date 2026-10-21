import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type OnDone = 'ask' | 'close' | 'keep';

export interface Config {
  port: number;
  claudeDir: string;
  claudeBin: string;
  cmuxBin: string;
  terminal: 'auto' | 'cmux' | 'none';
  pollIntervalMs: number;
  resumeCommand: string;
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
  terminal: 'auto',
  pollIntervalMs: 4000,
  resumeCommand: 'claude --resume {sessionId}',
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
  day: { startHour: 4, idleGapMinutes: 20 },
};

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
