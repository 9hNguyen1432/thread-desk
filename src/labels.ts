import type { Config } from './config.js';
import type { DB } from './db.js';
import { run } from './exec.js';
import { truncate } from './transcript/parse.js';

export type LabelSource = 'rule' | 'manual' | 'ai';

export interface ThreadLabel {
  name: string;
  source: LabelSource;
}

export interface LabelRule {
  label: string;
  /** Case-insensitive regular expression tested against the branch name. */
  branch?: string;
  /** Case-insensitive regular expression tested against the title and first prompt. */
  text?: string;
}

export const DEFAULT_LABELS = ['Support', 'Feature', 'Bug', 'Investigation', 'Review', 'Ops'];

/** First matching rule wins, so the more specific kinds of work come first. */
export const DEFAULT_LABEL_RULES: LabelRule[] = [
  { label: 'Support', text: '\\b(ticket support|support ticket|cs ticket|customer support|user report|CS)\\b|user báo|user bị|khách hàng' },
  { label: 'Review', text: '\\breview\\b|\\bPR #?\\d+' },
  { label: 'Investigation', text: '\\b(investigat\\w*|why|analy[sz]\\w*|audit)\\b|điều tra|phân tích' },
  { label: 'Bug', branch: '^(fix|bugfix|hotfix)/', text: '\\b(bug|crash|broken)\\b|lỗi' },
  { label: 'Feature', branch: '^feat(ure)?/', text: '\\b(implement|new feature|add support for)\\b' },
  { label: 'Ops', text: '\\b(deploy|infra|terraform|incident|alert|prod db)\\b' },
];

/** Rules only look at the start of a first prompt; pasted logs further down are noise. */
const RULE_TEXT_LIMIT = 2000;

interface CompiledRule {
  label: string;
  branch: RegExp | null;
  text: RegExp | null;
}

function compile(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    return null;
  }
}

export function compileRules(rules: LabelRule[], names: string[]): CompiledRule[] {
  const known = new Set(names);
  return rules
    .filter((r) => known.has(r.label))
    .map((r) => ({ label: r.label, branch: compile(r.branch), text: compile(r.text) }))
    .filter((r) => r.branch || r.text);
}

/** A branch name is a deliberate signal, so every branch rule is tried before any text rule. */
export function ruleLabel(rules: CompiledRule[], thread: { branch: string | null; title: string; firstPrompt: string | null }): string | null {
  if (thread.branch) for (const r of rules) if (r.branch?.test(thread.branch)) return r.label;
  const text = `${thread.title}\n${(thread.firstPrompt ?? '').slice(0, RULE_TEXT_LIMIT)}`;
  for (const r of rules) if (r.text?.test(text)) return r.label;
  return null;
}

export class LabelStore {
  constructor(private readonly db: DB) {}

  all(): Map<string, ThreadLabel> {
    const rows = this.db.prepare('select session_id, label, source from thread_labels').all() as { session_id: string; label: string; source: LabelSource }[];
    return new Map(rows.map((r) => [r.session_id, { name: r.label, source: r.source }]));
  }

  /** Stores an AI guess unless you picked a label in the meantime. */
  setGuess(sessionId: string, name: string): void {
    this.db
      .prepare(
        `insert into thread_labels (session_id, label, source, updated_at) values (?, ?, 'ai', ?)
         on conflict(session_id) do update set label = excluded.label, source = 'ai', updated_at = excluded.updated_at
         where thread_labels.source != 'manual'`,
      )
      .run(sessionId, name, Date.now());
  }

  /** `name` "" stores an explicit "no label"; null forgets the choice so rules apply again. */
  set(sessionId: string, name: string | null, source: LabelSource): void {
    if (name === null) {
      this.db.prepare('delete from thread_labels where session_id = ?').run(sessionId);
      return;
    }
    this.db
      .prepare(
        `insert into thread_labels (session_id, label, source, updated_at) values (?, ?, ?, ?)
         on conflict(session_id) do update set label = excluded.label, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(sessionId, name, source, Date.now());
  }
}

/**
 * Resolves the label of every thread: your choice, then a rule, then an AI guess. An explicit
 * "no label" choice comes back as an empty name so the UI can tell it from "not chosen".
 */
export function resolveLabels(
  stored: Map<string, ThreadLabel>,
  rules: CompiledRule[],
  threads: { id: string; branch: string | null; title: string; firstPrompt: string | null }[],
): Map<string, ThreadLabel | null> {
  const out = new Map<string, ThreadLabel | null>();
  for (const t of threads) {
    const own = stored.get(t.id);
    if (own?.source === 'manual') {
      out.set(t.id, own);
      continue;
    }
    const byRule = ruleLabel(rules, t);
    if (byRule) out.set(t.id, { name: byRule, source: 'rule' });
    else out.set(t.id, own?.source === 'ai' && own.name ? own : null);
  }
  return out;
}

export async function classifyWithAi(
  config: Config,
  cwd: string,
  names: string[],
  thread: { title: string; firstPrompt: string | null; lastPrompt: string | null },
): Promise<string | null> {
  const prompt = `Classify this coding-agent thread into exactly one of: ${names.join(', ')}. If none fits, answer None. Answer with the label only.`;
  const input = `TITLE: ${thread.title}\nFIRST REQUEST: ${truncate(thread.firstPrompt ?? '', 1500)}\nLATEST REQUEST: ${truncate(thread.lastPrompt ?? '', 600)}`;
  const { stdout } = await run(
    config.claudeBin,
    ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--tools', '', '--strict-mcp-config', '--disable-slash-commands'],
    { cwd, input, timeoutMs: 60_000 },
  );
  const result = (JSON.parse(stdout) as { result?: string }).result?.trim() ?? '';
  return names.find((n) => result.toLowerCase().startsWith(n.toLowerCase())) ?? null;
}
