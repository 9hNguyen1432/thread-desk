import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { run } from './exec.js';

export type AskStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface AskItem {
  sessionId: string;
  title: string;
  position: number;
  status: AskStatus;
  answer: string | null;
  error: string | null;
  included: boolean;
  sizeBytes: number;
}

export interface AskBatch {
  id: number;
  prompt: string;
  model: string;
  status: 'running' | 'done' | 'cancelled';
  createdAt: number;
  items: AskItem[];
  markdown: string;
}

interface ItemRow {
  batch_id: number;
  session_id: string;
  position: number;
  status: AskStatus;
  answer: string | null;
  error: string | null;
  included: number;
}

interface BatchRow {
  id: number;
  prompt: string;
  model: string;
  status: AskBatch['status'];
  created_at: number;
}

const MODEL_RE = /^[\w.-]{2,60}$/;
const ASK_TIMEOUT_MS = 10 * 60_000;

/**
 * Asks a thread a question without touching it: a forked, unsaved copy of the session answers
 * with read-only tools, so the original transcript, open tab and files stay exactly as they were.
 */
export function askArgs(prompt: string, sessionId: string, model: string): string[] {
  return [
    '-p',
    '--resume',
    sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--tools',
    'Read,Grep,Glob',
    '--model',
    model,
    '--output-format',
    'json',
    '--settings',
    '{"disableAllHooks":true}',
    '--strict-mcp-config',
    // The question goes last, after `--`, so one starting with "-" is never read as an option.
    '--',
    prompt,
  ];
}

export function combineAnswers(items: AskItem[], prompt: string): string {
  const chosen = items.filter((i) => i.included && i.status === 'done' && i.answer?.trim());
  const parts = [`Question asked to ${chosen.length} ${chosen.length === 1 ? 'thread' : 'threads'}: ${prompt}`, ''];
  for (const i of chosen) parts.push(`## ${i.title}`, '', i.answer!.trim(), '');
  return parts.join('\n').trim() + '\n';
}

export interface SessionInfo {
  title: string;
  cwd: string | null;
  file: string | null;
  transcriptExists: boolean;
}

export class AskRunner {
  private running = false;
  private current: { batchId: number; controller: AbortController } | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DB,
    private readonly config: () => Config,
    private readonly session: (id: string) => SessionInfo | null,
    private readonly changed: () => void,
    /** While true (for example during a reindex) sessions may be missing, so the queue waits. */
    private readonly paused: () => boolean = () => false,
  ) {
    // Work left running by a previous process never finished: retry it in running batches and
    // skip it in batches that were stopped.
    db.transaction(() => {
      db.prepare(
        `update ask_items set status = 'queued', started_at = null where status = 'running'
         and batch_id in (select id from ask_batches where status = 'running')`,
      ).run();
      db.prepare(
        `update ask_items set status = 'skipped' where status in ('running', 'queued')
         and batch_id in (select id from ask_batches where status != 'running')`,
      ).run();
    })();
    void this.drain();
  }

  /** Called when a pause (such as a reindex) ends. */
  resume(): void {
    void this.drain();
  }

  create(sessionIds: string[], prompt: string, model: string): number {
    if (!prompt.trim() || prompt.length > 4000) throw new Error('Write a question of up to 4,000 characters');
    if (!MODEL_RE.test(model)) throw new Error('Unknown model');
    const unique = [...new Set(sessionIds)];
    if (unique.length === 0 || unique.length > 100) throw new Error('Pick between 1 and 100 threads');
    for (const id of unique) if (!this.session(id)?.transcriptExists) throw new Error('One of the threads has no transcript left to ask');
    const id = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare("insert into ask_batches (prompt, model, status, created_at) values (?, ?, 'running', ?)")
        .run(prompt.trim(), model, Date.now());
      const batchId = Number(lastInsertRowid);
      const insert = this.db.prepare("insert into ask_items (batch_id, session_id, position, status) values (?, ?, ?, 'queued')");
      unique.forEach((sid, i) => insert.run(batchId, sid, i));
      return batchId;
    })();
    void this.drain();
    return id;
  }

  get(id: number): AskBatch | null {
    const batch = this.db.prepare('select * from ask_batches where id = ?').get(id) as BatchRow | undefined;
    if (!batch) return null;
    const rows = this.db.prepare('select * from ask_items where batch_id = ? order by position').all(id) as ItemRow[];
    const items: AskItem[] = rows.map((r) => {
      const info = this.session(r.session_id);
      let sizeBytes = 0;
      try {
        sizeBytes = info?.file && existsSync(info.file) ? statSync(info.file).size : 0;
      } catch {
        sizeBytes = 0;
      }
      return {
        sessionId: r.session_id,
        title: info?.title ?? r.session_id,
        position: r.position,
        status: r.status,
        answer: r.answer,
        error: r.error,
        included: r.included === 1,
        sizeBytes,
      };
    });
    return { id: batch.id, prompt: batch.prompt, model: batch.model, status: batch.status, createdAt: batch.created_at, items, markdown: combineAnswers(items, batch.prompt) };
  }

  recent(limit = 10): { id: number; prompt: string; status: string; createdAt: number; count: number; done: number }[] {
    return this.db
      .prepare(
        `select b.id, b.prompt, b.status, b.created_at as createdAt, count(i.session_id) as count,
           sum(case when i.status = 'done' then 1 else 0 end) as done
         from ask_batches b left join ask_items i on i.batch_id = b.id group by b.id order by b.id desc limit ?`,
      )
      .all(limit) as { id: number; prompt: string; status: string; createdAt: number; count: number; done: number }[];
  }

  updateItem(batchId: number, sessionId: string, patch: { included?: boolean; answer?: string }): void {
    if (patch.included !== undefined) {
      this.db.prepare('update ask_items set included = ? where batch_id = ? and session_id = ?').run(patch.included ? 1 : 0, batchId, sessionId);
    }
    if (patch.answer !== undefined) {
      this.db.prepare('update ask_items set answer = ? where batch_id = ? and session_id = ?').run(patch.answer.slice(0, 20_000), batchId, sessionId);
    }
  }

  cancel(batchId: number): void {
    this.db.transaction(() => {
      this.db.prepare("update ask_items set status = 'skipped' where batch_id = ? and status = 'queued'").run(batchId);
      this.db.prepare("update ask_batches set status = 'cancelled' where id = ? and status = 'running'").run(batchId);
    })();
    // Stop the question being asked right now too; it can otherwise run for minutes.
    if (this.current?.batchId === batchId) this.current.controller.abort();
    this.changed();
  }

  /** Writes the combined answers as Markdown into an existing folder, never over an existing file. */
  save(batchId: number, path: string): string {
    const batch = this.get(batchId);
    if (!batch) throw new Error('Batch not found');
    if (!isAbsolute(path) || !path.endsWith('.md')) throw new Error('Use a full path ending in .md');
    if (!existsSync(dirname(path))) throw new Error(`Folder does not exist: ${dirname(path)}`);
    if (existsSync(path)) throw new Error('A file already exists there; choose another name');
    writeFileSync(path, batch.markdown, { flag: 'wx' });
    return path;
  }

  /** One question at a time, so threads never compete for the same files, quota or memory. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.paused()) {
          this.retryTimer ??= setTimeout(() => {
            this.retryTimer = null;
            void this.drain();
          }, 5000);
          break;
        }
        const next = this.db
          .prepare(
            `select i.batch_id, i.session_id, b.prompt, b.model from ask_items i join ask_batches b on b.id = i.batch_id
             where i.status = 'queued' and b.status = 'running' order by i.batch_id, i.position limit 1`,
          )
          .get() as { batch_id: number; session_id: string; prompt: string; model: string } | undefined;
        if (!next) break;
        await this.runOne(next.batch_id, next.session_id, next.prompt, next.model);
        this.finishBatches();
        this.changed();
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(batchId: number, sessionId: string, prompt: string, model: string): Promise<void> {
    const mark = this.db.prepare('update ask_items set status = ?, answer = ?, error = ?, started_at = coalesce(started_at, ?), finished_at = ? where batch_id = ? and session_id = ?');
    mark.run('running', null, null, Date.now(), null, batchId, sessionId);
    this.changed();
    const info = this.session(sessionId);
    if (!info?.cwd || !existsSync(info.cwd)) {
      mark.run('failed', null, `The thread's folder no longer exists (${info?.cwd ?? 'unknown'})`, Date.now(), Date.now(), batchId, sessionId);
      return;
    }
    const controller = new AbortController();
    this.current = { batchId, controller };
    try {
      const { stdout } = await run(this.config().claudeBin, askArgs(prompt, sessionId, model), {
        cwd: info.cwd,
        input: '',
        timeoutMs: ASK_TIMEOUT_MS,
        signal: controller.signal,
      });
      const out = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (out.is_error || typeof out.result !== 'string') throw new Error(out.result || 'Claude returned no answer');
      mark.run('done', out.result.trim(), null, Date.now(), Date.now(), batchId, sessionId);
    } catch (e) {
      if (controller.signal.aborted) mark.run('skipped', null, 'Stopped', Date.now(), Date.now(), batchId, sessionId);
      else mark.run('failed', null, (e as Error).message.slice(0, 500), Date.now(), Date.now(), batchId, sessionId);
    } finally {
      this.current = null;
    }
  }

  private finishBatches(): void {
    this.db
      .prepare(
        `update ask_batches set status = 'done' where status = 'running'
         and not exists (select 1 from ask_items i where i.batch_id = ask_batches.id and i.status in ('queued', 'running'))`,
      )
      .run();
  }
}
