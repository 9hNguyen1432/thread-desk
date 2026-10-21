import type { DB } from './db.js';
import { run } from './exec.js';
import type { Recap } from './store.js';
import { truncate } from './transcript/parse.js';

const INSTRUCTIONS = `You summarize a coding session between a developer (USER) and Claude Code (ASSISTANT), given on stdin.
Reply with only a JSON object: {"goal": "...", "done": "...", "next": "...", "blocker": "..."}.
- goal: what the developer is trying to achieve (one sentence)
- done: what has been completed so far (one or two sentences)
- next: the immediate next step (one sentence)
- blocker: what is blocking progress or what the assistant is waiting for, or "" if nothing
Write in the same language the developer uses. Be concrete: name tickets, PRs, files.`;

export interface RecapMessage {
  role: string;
  text: string;
}

export function buildRecapInput(firstPrompt: string | null, messages: RecapMessage[]): string {
  const parts: string[] = [];
  if (firstPrompt) parts.push(`FIRST USER REQUEST:\n${truncate(firstPrompt, 2000)}`);
  parts.push('LATEST MESSAGES:');
  for (const m of messages) parts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${truncate(m.text, 1500)}`);
  return parts.join('\n\n');
}

export function parseRecapOutput(stdout: string): Recap {
  const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  if (envelope.is_error || typeof envelope.result !== 'string') throw new Error('claude -p returned no result');
  const text = envelope.result;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('recap is not JSON');
  const v = JSON.parse(text.slice(start, end + 1)) as Partial<Record<keyof Recap, unknown>>;
  const field = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  return { goal: field(v.goal), done: field(v.done), next: field(v.next), blocker: field(v.blocker) };
}

/**
 * Runs a throwaway, tool-less, hook-less print-mode session so the user's real session
 * and transcripts are never touched.
 */
export async function generateRecap(claudeBin: string, model: string, cwd: string, input: string): Promise<Recap> {
  const { stdout } = await run(
    claudeBin,
    [
      '-p',
      INSTRUCTIONS,
      '--model',
      model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true}',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
    ],
    { cwd, input, timeoutMs: 120_000 },
  );
  return parseRecapOutput(stdout);
}

/** Daily call counts kept in the database, so a restart does not reset the cap. */
export interface UsageCounter {
  used(day: string): number;
  add(day: string): void;
}

export function dbUsageCounter(db: DB, kind: string): UsageCounter {
  return {
    used: (day) => (db.prepare('select count from usage where day = ? and kind = ?').get(day, kind) as { count: number } | undefined)?.count ?? 0,
    add: (day) => {
      db.prepare('insert into usage (day, kind, count) values (?, ?, 1) on conflict(day, kind) do update set count = count + 1').run(day, kind);
    },
  };
}

export class RecapQueue {
  private queue: string[] = [];
  private running = false;
  private current: string | null = null;

  /** `work` resolves to true when it actually called the model, which is what the cap counts. */
  constructor(
    private readonly work: (sessionId: string) => Promise<boolean>,
    private readonly dailyCap: () => number,
    private readonly counter: UsageCounter,
  ) {}

  private get day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  get remainingToday(): number {
    return Math.max(0, this.dailyCap() - this.counter.used(this.day));
  }

  has(sessionId: string): boolean {
    return this.current === sessionId || this.queue.includes(sessionId);
  }

  push(sessionId: string): boolean {
    if (this.has(sessionId) || this.remainingToday <= 0) return false;
    this.queue.push(sessionId);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) {
        if (this.remainingToday <= 0) {
          this.queue = [];
          break;
        }
        this.current = id;
        // A failed call still costs quota, so it counts as spent.
        const spent = await this.work(id).catch(() => true);
        if (spent) this.counter.add(this.day);
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }
}
