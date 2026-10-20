/**
 * Claude Code transcript lines are an internal format that may change in any release,
 * so every field is optional and unknown line types are ignored.
 */
export interface ParsedLine {
  ts?: number;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  pr?: { number: number; url: string; repo?: string };
  continuedIn?: string;
  human?: string;
  assistant?: string;
}

export const MAX_HUMAN_CHARS = 4000;
export const MAX_ASSISTANT_CHARS = 8000;

const INJECTED_PREFIXES = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  'Another Claude session sent a message',
  '[Request interrupted',
  'Caveat: The messages below were generated',
];

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Json).type === 'text') {
      const text = str((block as Json).text);
      if (text) out.push(text);
    }
  }
  return out;
}

export function cleanHumanText(raw: string): string | undefined {
  const trimmed = raw.trimStart();
  if (INJECTED_PREFIXES.some((p) => trimmed.startsWith(p))) return undefined;

  const command = /^<command-name>([^<]*)<\/command-name>/.exec(trimmed);
  if (command) {
    const name = command[1]!.trim();
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1] ?? '').trim();
    return truncate(args ? `${name} ${args}` : name, MAX_HUMAN_CHARS);
  }

  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
  return text ? truncate(text, MAX_HUMAN_CHARS) : undefined;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function parseLine(line: string): ParsedLine | null {
  let d: Json;
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    d = value as Json;
  } catch {
    return null;
  }

  const out: ParsedLine = {};
  const ts = str(d.timestamp);
  if (ts) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) out.ts = ms;
  }

  switch (d.type) {
    case 'custom-title':
      out.customTitle = str(d.customTitle);
      return out;
    case 'ai-title':
      out.aiTitle = str(d.aiTitle);
      return out;
    case 'agent-name':
      out.agentName = str(d.agentName);
      return out;
    case 'continued-in':
      out.continuedIn = str(d.continuedInSessionId);
      return out;
    case 'pr-link': {
      const url = str(d.prUrl);
      const number = typeof d.prNumber === 'number' ? d.prNumber : undefined;
      if (url && number !== undefined) out.pr = { number, url, repo: str(d.prRepository) };
      return out;
    }
    case 'user':
    case 'assistant':
      break;
    default:
      return out.ts === undefined ? null : out;
  }

  if (d.isSidechain === true) return null;
  out.cwd = str(d.cwd);
  out.gitBranch = str(d.gitBranch);
  out.version = str(d.version);

  const message = d.message as Json | undefined;
  if (!message || typeof message !== 'object') return out;

  if (d.type === 'assistant') {
    const text = textBlocks(message.content).join('\n').trim();
    if (text) out.assistant = truncate(text, MAX_ASSISTANT_CHARS);
    return out;
  }

  if (d.isMeta === true || d.isCompactSummary === true || d.isVisibleInTranscriptOnly === true) return out;
  const origin = d.origin as Json | undefined;
  if (origin && typeof origin === 'object' && origin.kind !== undefined && origin.kind !== 'human') return out;
  const text = textBlocks(message.content).join('\n');
  if (text) out.human = cleanHumanText(text);
  return out;
}

export function displayTitle(s: {
  custom_title?: string | null;
  agent_name?: string | null;
  ai_title?: string | null;
  first_prompt?: string | null;
}): string {
  const title = s.custom_title ?? s.agent_name ?? s.ai_title ?? s.first_prompt ?? 'Untitled session';
  return truncate(title.replace(/\s+/g, ' ').trim(), 120);
}
