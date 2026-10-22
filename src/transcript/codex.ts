import { MAX_ASSISTANT_CHARS, MAX_HUMAN_CHARS, truncate, type ParsedLine } from './parse.js';

/**
 * Codex rollout lines are `{timestamp, type, payload}`. Only the session header, the turn
 * context and the user/agent message events matter here; `response_item` lines repeat the
 * same messages plus injected context, so they are skipped.
 */
type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

export function parseCodexLine(line: string): ParsedLine | null {
  let d: Json | undefined;
  try {
    d = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!d) return null;
  const payload = obj(d.payload);
  if (!payload) return null;

  const out: ParsedLine = {};
  const ts = Date.parse(str(d.timestamp) ?? '');
  if (!Number.isNaN(ts)) out.ts = ts;

  switch (d.type) {
    case 'session_meta': {
      out.cwd = str(payload.cwd);
      out.version = str(payload.cli_version);
      out.gitBranch = str(obj(payload.git)?.branch);
      return out;
    }
    case 'turn_context':
      out.cwd = str(payload.cwd);
      return out;
    case 'event_msg':
      break;
    default:
      return null;
  }

  switch (payload.type) {
    case 'user_message': {
      const text = str(payload.message)?.trim();
      if (text) out.human = truncate(text, MAX_HUMAN_CHARS);
      return out;
    }
    case 'agent_message': {
      const text = str(payload.message)?.trim();
      if (text) out.assistant = truncate(text, MAX_ASSISTANT_CHARS);
      return out;
    }
    case 'session_configured':
      out.customTitle = str(payload.thread_name);
      return out;
    default:
      return null;
  }
}
