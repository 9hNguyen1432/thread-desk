import { MAX_ASSISTANT_CHARS, MAX_HUMAN_CHARS, truncate, type ParsedLine } from './parse.js';

/**
 * Pi session files (pi-coding-agent `docs/session-format.md`): a `session` header line with id
 * and cwd, then `message` entries holding user/assistant messages, plus `session_info` for a
 * name set with `/name`. Tool results, bash runs and extension entries are skipped.
 */
type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .filter((b): b is Json => b?.type === 'text')
    .map((b) => str(b.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

export function parsePiLine(line: string): ParsedLine | null {
  let d: Json | undefined;
  try {
    d = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!d) return null;
  const out: ParsedLine = {};
  const ts = Date.parse(str(d.timestamp) ?? '');
  if (!Number.isNaN(ts)) out.ts = ts;

  switch (d.type) {
    case 'session':
      out.cwd = str(d.cwd);
      return out;
    case 'session_info':
      out.customTitle = str(d.name);
      return out;
    case 'message':
      break;
    default:
      return null;
  }

  const message = obj(d.message);
  if (!message) return out;
  if (message.role === 'user') {
    const t = text(message.content).trim();
    if (t) out.human = truncate(t, MAX_HUMAN_CHARS);
  } else if (message.role === 'assistant') {
    const t = text(message.content).trim();
    if (t) out.assistant = truncate(t, MAX_ASSISTANT_CHARS);
  }
  return out;
}
