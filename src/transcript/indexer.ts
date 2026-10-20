import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { DB } from '../db.js';
import { SOURCE_PRIORITY, extractLinks, ticketPrefixCandidates, ticketRegex, type LinkRef, type LinkSource } from '../links.js';
import { parseLine, type ParsedLine } from './parse.js';
import { resolveProject } from './project.js';

export interface SessionRow {
  id: string;
  file: string;
  cwd: string | null;
  project: string | null;
  git_branch: string | null;
  custom_title: string | null;
  ai_title: string | null;
  agent_name: string | null;
  first_prompt: string | null;
  last_prompt: string | null;
  last_assistant: string | null;
  first_at: number | null;
  last_at: number | null;
  last_human_at: number | null;
  last_assistant_at: number | null;
  human_count: number;
  message_count: number;
  claude_version: string | null;
  continued_in: string | null;
  transcript_exists: number;
}

export interface IndexerListener {
  sessionsChanged(ids: string[]): void;
  sessionsReopened(ids: string[]): void;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function normalizeForSearch(text: string): string {
  return text.replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

const PRIORITY_SQL = (col: string) =>
  `case ${col} ${Object.entries(SOURCE_PRIORITY).map(([s, p]) => `when '${s}' then ${p}`).join(' ')} else 0 end`;

function emptySession(id: string, file: string): SessionRow {
  return {
    id,
    file,
    cwd: null,
    project: null,
    git_branch: null,
    custom_title: null,
    ai_title: null,
    agent_name: null,
    first_prompt: null,
    last_prompt: null,
    last_assistant: null,
    first_at: null,
    last_at: null,
    last_human_at: null,
    last_assistant_at: null,
    human_count: 0,
    message_count: 0,
    claude_version: null,
    continued_in: null,
    transcript_exists: 1,
  };
}

export class Indexer {
  private ticketRe: RegExp | null;
  private queue: Promise<void> = Promise.resolve();
  private timers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private readonly projectsDir: string;
  private readonly stmts;

  constructor(
    private readonly db: DB,
    claudeDir: string,
    ticketKeys: string[],
    private readonly listener: IndexerListener,
  ) {
    this.projectsDir = join(claudeDir, 'projects');
    this.ticketRe = ticketRegex(ticketKeys);
    this.stmts = {
      getSession: db.prepare<[string], SessionRow>('select * from sessions where id = ?'),
      upsertSession: db.prepare(`
        insert into sessions (id, file, cwd, project, git_branch, custom_title, ai_title, agent_name, first_prompt,
          last_prompt, last_assistant, first_at, last_at, last_human_at, last_assistant_at, human_count, message_count,
          claude_version, continued_in, transcript_exists)
        values (@id, @file, @cwd, @project, @git_branch, @custom_title, @ai_title, @agent_name, @first_prompt,
          @last_prompt, @last_assistant, @first_at, @last_at, @last_human_at, @last_assistant_at, @human_count,
          @message_count, @claude_version, @continued_in, @transcript_exists)
        on conflict(id) do update set file = excluded.file, cwd = excluded.cwd, project = excluded.project,
          git_branch = excluded.git_branch, custom_title = excluded.custom_title, ai_title = excluded.ai_title,
          agent_name = excluded.agent_name, first_prompt = excluded.first_prompt, last_prompt = excluded.last_prompt,
          last_assistant = excluded.last_assistant, first_at = excluded.first_at, last_at = excluded.last_at,
          last_human_at = excluded.last_human_at, last_assistant_at = excluded.last_assistant_at,
          human_count = excluded.human_count, message_count = excluded.message_count,
          claude_version = excluded.claude_version, continued_in = excluded.continued_in,
          transcript_exists = excluded.transcript_exists`),
      getFile: db.prepare<[string], { offset: number; size: number; mtime: number }>(
        'select offset, size, mtime from files where path = ?',
      ),
      upsertFile: db.prepare(`
        insert into files (path, session_id, offset, size, mtime) values (?, ?, ?, ?, ?)
        on conflict(path) do update set offset = excluded.offset, size = excluded.size, mtime = excluded.mtime`),
      insertMessage: db.prepare('insert into messages (session_id, role, ts, text) values (?, ?, ?, ?)'),
      insertFts: db.prepare('insert into messages_fts (rowid, norm) values (?, ?)'),
      upsertLink: db.prepare(`
        insert into links (session_id, kind, key, url, mentions, first_at, source) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(session_id, kind, key) do update set
          mentions = links.mentions + excluded.mentions,
          url = coalesce(links.url, excluded.url),
          first_at = coalesce(links.first_at, excluded.first_at),
          source = case when ${PRIORITY_SQL('excluded.source')} > ${PRIORITY_SQL('links.source')}
            then excluded.source else links.source end`),
      bumpPrefix: db.prepare(`
        insert into key_prefixes (prefix, count) values (?, 1)
        on conflict(prefix) do update set count = count + 1`),
      reopen: db.prepare(`
        update user_state set lifecycle = 'active', done_at = null, updated_at = ?
        where session_id = ? and lifecycle != 'active' and updated_at < ?`),
      markMissing: db.prepare('update sessions set transcript_exists = 0 where file = ?'),
      deleteSessionFts: db.prepare('delete from messages_fts where rowid in (select id from messages where session_id = ?)'),
      deleteSessionMessages: db.prepare('delete from messages where session_id = ?'),
      deleteSessionLinks: db.prepare('delete from links where session_id = ? and hidden = 0'),
      deleteSession: db.prepare('delete from sessions where id = ?'),
      setProject: db.prepare('update sessions set project = ? where id = ?'),
    };
  }

  setTicketKeys(keys: string[]): void {
    this.ticketRe = ticketRegex(keys);
  }

  /** Serializes all index work so concurrent file events never interleave writes. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Runs work while no file sync is in progress. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  async listSessionFiles(): Promise<string[]> {
    let dirs: string[];
    try {
      dirs = await readdir(this.projectsDir);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(join(this.projectsDir, dir));
      } catch {
        continue;
      }
      for (const entry of entries) if (SESSION_FILE_RE.test(entry)) files.push(join(this.projectsDir, dir, entry));
    }
    return files;
  }

  async scanAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const files = await this.listSessionFiles();
    const present = new Set(files);
    const known = this.db.prepare<[], { file: string }>('select file from sessions where transcript_exists = 1').all();
    for (const { file } of known) if (!present.has(file)) this.stmts.markMissing.run(file);
    let done = 0;
    for (const file of files) {
      await this.enqueue(() => this.syncFile(file)).catch((e: Error) => this.recordError(file, e));
      onProgress?.(++done, files.length);
    }
  }

  /** Files that could not be read last time, so one bad transcript never stops the scan. */
  readonly errors = new Map<string, string>();

  private recordError(file: string, e: Error): void {
    this.errors.set(file, e.message);
    if (this.errors.size > 50) this.errors.delete(this.errors.keys().next().value!);
  }

  watch(): void {
    this.watcher = chokidar.watch(this.projectsDir, {
      ignoreInitial: true,
      depth: 1,
      ignored: (path, stats) => Boolean(stats?.isFile() && !SESSION_FILE_RE.test(basename(path))),
    });
    const schedule = (path: string) => {
      if (!SESSION_FILE_RE.test(basename(path))) return;
      clearTimeout(this.timers.get(path));
      this.timers.set(
        path,
        setTimeout(() => {
          this.timers.delete(path);
          void this.enqueue(() => this.syncFile(path)).catch((e: Error) => this.recordError(path, e));
        }, 300),
      );
    };
    this.watcher.on('add', schedule).on('change', schedule);
    this.watcher.on('unlink', (path) => {
      this.stmts.markMissing.run(path);
      const id = basename(path, '.jsonl');
      this.listener.sessionsChanged([id]);
    });
  }

  async close(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    await this.watcher?.close();
  }

  syncPath(path: string): Promise<void> {
    if (!SESSION_FILE_RE.test(basename(path))) return Promise.resolve();
    return this.enqueue(() => this.syncFile(path));
  }

  private resetSession(id: string): void {
    this.stmts.deleteSessionFts.run(id);
    this.stmts.deleteSessionMessages.run(id);
    this.stmts.deleteSessionLinks.run(id);
    this.stmts.deleteSession.run(id);
  }

  private async syncFile(path: string): Promise<void> {
    this.errors.delete(path);
    let info;
    try {
      info = await stat(path);
    } catch {
      this.stmts.markMissing.run(path);
      return;
    }
    const id = basename(path, '.jsonl');
    const prev = this.stmts.getFile.get(path);
    let offset = prev?.offset ?? 0;
    if (prev && info.size < prev.offset) {
      this.db.transaction(() => this.resetSession(id))();
      offset = 0;
    }
    if (prev && info.size === prev.size && Math.trunc(info.mtimeMs) === prev.mtime && offset === info.size) return;

    const session = this.stmts.getSession.get(id) ?? emptySession(id, path);
    session.file = path;
    session.transcript_exists = 1;
    const cwdBefore = session.cwd;
    const humanBefore = session.last_human_at;

    const handle = await open(path, 'r');
    try {
      let carry = Buffer.alloc(0);
      let position = offset;
      while (position < info.size) {
        const length = Math.min(CHUNK_BYTES, info.size - position);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl === -1) {
          carry = data;
          continue;
        }
        const complete = data.subarray(0, lastNl).toString('utf8');
        carry = Buffer.from(data.subarray(lastNl + 1));
        const consumedTo = position - carry.length;
        this.db.transaction(() => {
          for (const line of complete.split('\n')) {
            if (!line) continue;
            const parsed = parseLine(line);
            if (parsed) this.apply(session, parsed);
          }
          this.stmts.upsertSession.run(session);
          this.stmts.upsertFile.run(path, id, consumedTo, info.size, Math.trunc(info.mtimeMs));
        })();
      }
      this.db.transaction(() => {
        this.applyDerivedLinks(session);
        this.stmts.upsertSession.run(session);
        if (!this.stmts.getFile.get(path)) this.stmts.upsertFile.run(path, id, offset, info.size, Math.trunc(info.mtimeMs));
      })();
    } finally {
      await handle.close();
    }

    if (session.cwd && (session.cwd !== cwdBefore || !session.project)) {
      const project = await resolveProject(session.cwd);
      this.stmts.setProject.run(project, id);
    }

    if (session.last_human_at && session.last_human_at !== humanBefore) {
      const res = this.stmts.reopen.run(Date.now(), id, session.last_human_at);
      if (res.changes > 0) this.listener.sessionsReopened([id]);
    }
    this.listener.sessionsChanged([id]);
  }

  private upsertLinks(sessionId: string, refs: LinkRef[], source: LinkSource, ts: number | null, mentions: number): void {
    for (const ref of refs) this.stmts.upsertLink.run(sessionId, ref.kind, ref.key, ref.url, mentions, ts, source);
  }

  private apply(s: SessionRow, p: ParsedLine): void {
    if (p.ts !== undefined) {
      if (s.first_at === null || p.ts < s.first_at) s.first_at = p.ts;
      if (s.last_at === null || p.ts > s.last_at) s.last_at = p.ts;
    }
    if (p.cwd) s.cwd = p.cwd;
    if (p.gitBranch) s.git_branch = p.gitBranch;
    if (p.version) s.claude_version = p.version;
    if (p.customTitle) s.custom_title = p.customTitle;
    if (p.aiTitle) s.ai_title = p.aiTitle;
    if (p.agentName) s.agent_name = p.agentName;
    if (p.continuedIn) s.continued_in = p.continuedIn;
    const ts = p.ts ?? null;
    if (p.pr) {
      const [owner, repo] = (p.pr.repo ?? '').split('/');
      const fromUrl = extractLinks(p.pr.url, null).find((l) => l.kind === 'pr');
      const key = fromUrl?.key ?? (owner && repo ? `${owner.toLowerCase()}/${repo.toLowerCase()}#${p.pr.number}` : null);
      if (key) this.upsertLinks(s.id, [{ kind: 'pr', key, url: p.pr.url }], 'pr-link', ts, 0);
    }
    if (p.human) {
      s.human_count += 1;
      s.message_count += 1;
      s.first_prompt ??= p.human;
      s.last_prompt = p.human;
      if (ts !== null) s.last_human_at = ts;
      this.insertMessage(s.id, 'user', ts, p.human);
      this.upsertLinks(s.id, extractLinks(p.human, this.ticketRe), 'user', ts, 1);
      for (const prefix of ticketPrefixCandidates(p.human)) this.stmts.bumpPrefix.run(prefix);
    }
    if (p.assistant) {
      s.message_count += 1;
      s.last_assistant = p.assistant;
      if (ts !== null) s.last_assistant_at = ts;
      this.insertMessage(s.id, 'assistant', ts, p.assistant);
      this.upsertLinks(s.id, extractLinks(p.assistant, this.ticketRe), 'assistant', ts, 1);
    }
  }

  private applyDerivedLinks(s: SessionRow): void {
    const title = s.custom_title ?? s.agent_name ?? s.ai_title;
    if (title) this.upsertLinks(s.id, extractLinks(title, this.ticketRe), 'title', s.first_at, 0);
    if (s.git_branch && this.ticketRe) {
      const refs = extractLinks(s.git_branch, this.ticketRe).filter((l) => l.kind === 'ticket');
      this.upsertLinks(s.id, refs, 'branch', s.first_at, 0);
    }
  }

  private insertMessage(sessionId: string, role: 'user' | 'assistant', ts: number | null, text: string): void {
    const { lastInsertRowid } = this.stmts.insertMessage.run(sessionId, role, ts, text);
    this.stmts.insertFts.run(lastInsertRowid, normalizeForSearch(text));
  }
}
