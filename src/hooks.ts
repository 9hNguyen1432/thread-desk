import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookState } from './board.js';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd'] as const;
export const SECRET_HEADER = 'X-Thread-Desk-Secret';

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  notification_type?: string;
  message?: string;
}

export type HookEffect =
  | { kind: 'set'; sessionId: string; state: HookState }
  | { kind: 'clear'; sessionId: string }
  | { kind: 'none' };

const NEEDS_YOU_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt', 'agent_needs_input', 'elicitation_dialog']);

export function hookEffect(p: HookPayload, now: number): HookEffect {
  const sessionId = p.session_id;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return { kind: 'none' };
  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'set', sessionId, state: { status: 'running', at: now, lastAssistantMessage: null } };
    case 'SessionStart':
      return { kind: 'set', sessionId, state: { status: 'idle', at: now, lastAssistantMessage: null } };
    case 'Stop':
      return {
        kind: 'set',
        sessionId,
        state: { status: 'needs_you', at: now, lastAssistantMessage: p.last_assistant_message?.trim() || null },
      };
    case 'Notification':
      if (p.notification_type && NEEDS_YOU_NOTIFICATIONS.has(p.notification_type)) {
        return { kind: 'set', sessionId, state: { status: 'needs_you', at: now, lastAssistantMessage: null } };
      }
      return { kind: 'none' };
    case 'SessionEnd':
      return { kind: 'clear', sessionId };
    default:
      return { kind: 'none' };
  }
}

interface HookHandler {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [k: string]: unknown;
}

type Settings = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

function isOurs(h: HookHandler): boolean {
  return h.type === 'http' && Boolean(h.headers && SECRET_HEADER in h.headers);
}

export function settingsPath(claudeDir: string): string {
  return join(claudeDir, 'settings.json');
}

function readSettings(file: string): Settings {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
}

/** Removes our handlers, and only the groups and events that removing them left empty. */
export function withoutOurHooks(settings: Settings): Settings {
  if (!settings.hooks || !Object.values(settings.hooks).some((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(isOurs)))) {
    return settings;
  }
  const hooks = { ...settings.hooks };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const touched = groups.some((g) => (g.hooks ?? []).some(isOurs));
    if (!touched) continue;
    const kept = groups.flatMap((g) => {
      const own = g.hooks ?? [];
      if (!own.some(isOurs)) return [g];
      const rest = own.filter((h) => !isOurs(h));
      return rest.length > 0 ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const { hooks: _previous, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export function withOurHooks(settings: Settings, port: number, secret: string): Settings {
  const base = withoutOurHooks(settings);
  const hooks = { ...(base.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const handler: HookHandler = {
      type: 'http',
      url: `http://127.0.0.1:${port}/hooks`,
      headers: { [SECRET_HEADER]: secret },
      timeout: 5,
    };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return { ...base, hooks };
}

export function hooksInstalled(claudeDir: string): boolean {
  const settings = readSettings(settingsPath(claudeDir));
  return Object.values(settings.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
}

function backupAndWrite(file: string, next: Settings): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    let stamp = new Date().toISOString().replace(/[-:.]/g, '');
    for (let n = 1; existsSync(`${file}.thread-desk-${stamp}.bak`); n++) stamp = `${stamp.replace(/-\d+$/, '')}-${n}`;
    backup = `${file}.thread-desk-${stamp}.bak`;
    copyFileSync(file, backup);
  }
  // Write-then-rename so Claude Code never reads a half-written settings file.
  const tmp = `${file}.thread-desk-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
  return backup;
}

export function installHooks(claudeDir: string, port: number, secret: string): { file: string; backup: string | null } {
  const file = settingsPath(claudeDir);
  const next = withOurHooks(readSettings(file), port, secret);
  return { file, backup: backupAndWrite(file, next) };
}

export function uninstallHooks(claudeDir: string): { file: string; backup: string | null; changed: boolean } {
  const file = settingsPath(claudeDir);
  if (!existsSync(file)) return { file, backup: null, changed: false };
  const current = readSettings(file);
  const next = withoutOurHooks(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return { file, backup: null, changed: false };
  return { file, backup: backupAndWrite(file, next), changed: true };
}
