import { open, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentKind } from '../agents.js';
import type { DB } from '../db.js';
import { SOURCE_PRIORITY, extractLinks, ticketPrefixCandidates, ticketRegex, type LinkRef, type LinkSource } from '../links.js';
import type { ParsedLine } from './parse.js';
import { resolveBranch, resolveProject } from './project.js';
import type { PolledSource } from './copilot.js';
import type { JsonlSource } from './sources.js';
import { decompressZstd } from './zstd.js';

export interface SessionRow {
  id: string;
  agent: AgentKind;
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

export function normalizeForSearch(text: string): string {
  return text.replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

const PRIORITY_SQL = (col: string) =>
  `case ${col} ${Object.entries(SOURCE_PRIORITY).map(([s, p]) => `when '${s}' then ${p}`).join(' ')} else 0 end`;

function emptySession(id: string, agent: AgentKind, file: string): SessionRow {
  return {
    id,
    agent,
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
  private watchers: FSWatcher[] = [];
  private readonly stmts;

  constructor(
    private readonly db: DB,
    private readonly sources: JsonlSource[],
    ticketKeys: string[],
    private readonly listener: IndexerListener,
    private readonly polled: PolledSource[] = [],
  ) {
    this.ticketRe = ticketRegex(ticketKeys);
    this.stmts = {
      getSession: db.prepare<[string], SessionRow>('select * from sessions where id = ?'),
      upsertSession: db.prepare(`
        insert into sessions (id, agent, file, cwd, project, git_branch, custom_title, ai_title, agent_name, first_prompt,
          last_prompt, last_assistant, first_at, last_at, last_human_at, last_assistant_at, human_count, message_count,
          claude_version, continued_in, transcript_exists)
        values (@id, @agent, @file, @cwd, @project, @git_branch, @custom_title, @ai_title, @agent_name, @first_prompt,
          @last_prompt, @last_assistant, @first_at, @last_at, @last_human_at, @last_assistant_at, @human_count,
          @message_count, @claude_version, @continued_in, @transcript_exists)
        on conflict(id) do update set agent = excluded.agent, file = excluded.file, cwd = excluded.cwd, project = excluded.project,
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
      markPresent: db.prepare('update sessions set transcript_exists = 1 where id = ? and file = ? and transcript_exists = 0'),
      liveFilesOf: db.prepare<[string], { file: string; id: string }>(
        'select file, id from sessions where agent = ? and transcript_exists = 1',
      ),
      deleteSessionFts: db.prepare('delete from messages_fts where rowid in (select id from messages where session_id = ?)'),
      deleteSessionMessages: db.prepare('delete from messages where session_id = ?'),
      deleteSessionLinks: db.prepare('delete from links where session_id = ? and hidden = 0'),
      deleteSession: db.prepare('delete from sessions where id = ?'),
      setProject: db.prepare('update sessions set project = ? where id = ?'),
      setBranch: db.prepare('update sessions set git_branch = ? where id = ?'),
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

  /** The source a path belongs to, and the session it holds; null for anything else. */
  private locate(path: string): { source: JsonlSource; id: string } | null {
    for (const source of this.sources) {
      const rel = relative(source.root, path);
      if (!rel || rel.startsWith('..') || rel.split(sep).length !== source.depth + 1) continue;
      const id = source.sessionId(path);
      if (id) return { source, id };
    }
    return null;
  }

  async listSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const source of this.sources) {
      let level = [source.root];
      for (let d = 0; d < source.depth; d++) {
        const next: string[] = [];
        for (const dir of level) {
          try {
            for (const entry of await readdir(dir)) next.push(join(dir, entry));
          } catch {
            // Not a directory, or gone: nothing to list.
          }
        }
        level = next;
      }
      for (const dir of level) {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        // A plain transcript hides a compressed sibling of the same session.
        const names = new Set(entries);
        for (const entry of entries) {
          if (entry.endsWith('.zst') && names.has(entry.slice(0, -4))) continue;
          const path = join(dir, entry);
          if (this.locate(path)) files.push(path);
        }
      }
    }
    return files;
  }

  async scanAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const files = await this.listSessionFiles();
    const present = new Set(files);
    // Database-backed agents keep virtual file names; syncPolled checks those against their store.
    const polledAgents = new Set(this.polled.map((p) => p.agent));
    const known = this.db.prepare<[], { file: string; agent: AgentKind }>('select file, agent from sessions where transcript_exists = 1').all();
    for (const { file, agent } of known) if (!polledAgents.has(agent) && !present.has(file)) this.stmts.markMissing.run(file);
    let done = 0;
    for (const file of files) {
      await this.enqueue(() => this.syncFile(file)).catch((e: Error) => this.recordError(file, e));
      onProgress?.(++done, files.length);
    }
    for (const source of this.polled) {
      await this.enqueue(() => this.syncPolled(source)).catch((e: Error) => this.recordError(source.agent, e));
    }
  }

  /** Files that could not be read last time, so one bad transcript never stops the scan. */
  readonly errors = new Map<string, string>();

  private recordError(file: string, e: Error): void {
    this.errors.set(file, e.message);
    if (this.errors.size > 50) this.errors.delete(this.errors.keys().next().value!);
  }

  watch(): void {
    for (const source of this.sources) {
      // chokidar cannot watch a directory that does not exist yet; such agents are picked up on restart.
      if (!existsSync(source.root)) continue;
      this.watchers.push(this.watchSource(source));
    }
    for (const source of this.polled) {
      const watcher = chokidar.watch(source.watchFiles, { ignoreInitial: true });
      const schedule = () => {
        clearTimeout(this.timers.get(source.agent));
        this.timers.set(
          source.agent,
          setTimeout(() => {
            this.timers.delete(source.agent);
            void this.enqueue(() => this.syncPolled(source)).catch((e: Error) => this.recordError(source.agent, e));
          }, 500),
        );
      };
      watcher.on('add', schedule).on('change', schedule);
      this.watchers.push(watcher);
    }
  }

  private watchSource(source: JsonlSource): FSWatcher {
    const watcher = chokidar.watch(source.root, {
      ignoreInitial: true,
      depth: source.depth,
      ignored: (path, stats) => Boolean(stats?.isFile() && !this.locate(path)),
    });
    const schedule = (path: string) => {
      if (!this.locate(path)) return;
      clearTimeout(this.timers.get(path));
      this.timers.set(
        path,
        setTimeout(() => {
          this.timers.delete(path);
          void this.enqueue(() => this.syncFile(path)).catch((e: Error) => this.recordError(path, e));
        }, 300),
      );
    };
    watcher.on('add', schedule).on('change', schedule);
    watcher.on('unlink', (path) => {
      const found = this.locate(path);
      if (!found) return;
      this.stmts.markMissing.run(path);
      this.listener.sessionsChanged([found.id]);
      // Codex replaces a cold transcript with a compressed copy that the listing hid until now.
      if (existsSync(`${path}.zst`)) schedule(`${path}.zst`);
    });
    return watcher;
  }

  async close(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.all(this.watchers.map((w) => w.close()));
    for (const source of this.polled) source.close();
  }

  /** Database-backed sessions get a virtual file name so the rest of the index treats them alike. */
  private async syncPolled(source: PolledSource): Promise<void> {
    this.errors.delete(source.agent);
    const listed = source.list();
    const seen = new Set<string>();
    for (const { id, stamp } of listed) {
      const key = `${source.agent}:${id}`;
      seen.add(key);
      const prev = this.stmts.getFile.get(key);
      if (prev && prev.mtime === stamp) {
        if (this.stmts.markPresent.run(id, key).changes > 0) this.listener.sessionsChanged([id]);
        continue;
      }
      let from = prev?.offset ?? 0;
      const existing = this.stmts.getSession.get(id);
      if (!prev && existing) {
        this.db.transaction(() => this.resetSession(id))();
        from = 0;
      }
      const session = this.stmts.getSession.get(id) ?? emptySession(id, source.agent, key);
      session.agent = source.agent;
      session.file = key;
      session.transcript_exists = 1;
      const cwdBefore = session.cwd;
      const humanBefore = session.last_human_at;
      const { lines, next } = source.read(id, from);
      this.db.transaction(() => {
        for (const line of lines) this.apply(session, line);
        this.applyDerivedLinks(session);
        this.stmts.upsertSession.run(session);
        this.stmts.upsertFile.run(key, id, next, 0, stamp);
      })();
      await this.afterSync(session, cwdBefore, humanBefore);
    }
    for (const row of this.stmts.liveFilesOf.all(source.agent)) {
      if (seen.has(row.file)) continue;
      this.stmts.markMissing.run(row.file);
      this.listener.sessionsChanged([row.id]);
    }
  }

  syncPath(path: string): Promise<void> {
    if (!this.locate(path)) return Promise.resolve();
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
    const found = this.locate(path);
    if (!found) return;
    const { source, id } = found;
    let info;
    try {
      info = await stat(path);
    } catch {
      this.stmts.markMissing.run(path);
      return;
    }
    const prev = this.stmts.getFile.get(path);
    if (prev && info.size === prev.size && Math.trunc(info.mtimeMs) === prev.mtime && prev.offset === info.size) {
      // Unchanged, but it may have been marked missing while its agent was turned off.
      if (this.stmts.markPresent.run(id, path).changes > 0) this.listener.sessionsChanged([id]);
      return;
    }
    let offset = prev?.offset ?? 0;
    const existing = this.stmts.getSession.get(id);
    // A shorter file was rewritten, a compressed file can only be read whole, and a session that
    // moved to another file (Codex compressing a cold transcript) would otherwise be read twice.
    const compressed = path.endsWith('.zst');
    if ((prev && info.size < prev.offset) || (prev && compressed) || (!prev && existing && existing.file !== path)) {
      this.db.transaction(() => this.resetSession(id))();
      offset = 0;
    }

    const session = this.stmts.getSession.get(id) ?? emptySession(id, source.agent, path);
    session.agent = source.agent;
    session.file = path;
    session.transcript_exists = 1;
    const cwdBefore = session.cwd;
    const humanBefore = session.last_human_at;

    if (compressed) {
      const text = decompressZstd(await readFile(path)).toString('utf8');
      this.db.transaction(() => {
        for (const line of text.split('\n')) {
          if (!line) continue;
          const parsed = source.parseLine(line);
          if (parsed) this.apply(session, parsed);
        }
        this.applyDerivedLinks(session);
        this.stmts.upsertSession.run(session);
        this.stmts.upsertFile.run(path, id, info.size, info.size, Math.trunc(info.mtimeMs));
      })();
      await this.afterSync(session, cwdBefore, humanBefore);
      return;
    }

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
            const parsed = source.parseLine(line);
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
    await this.afterSync(session, cwdBefore, humanBefore);
  }

  private async afterSync(session: SessionRow, cwdBefore: string | null, humanBefore: number | null): Promise<void> {
    const id = session.id;
    if (session.cwd && (session.cwd !== cwdBefore || !session.project)) {
      const project = await resolveProject(session.cwd);
      this.stmts.setProject.run(project, id);
    }
    // Pi does not record the branch; the checkout's current branch is the best available guess.
    if (session.cwd && !session.git_branch && session.agent === 'pi') {
      const branch = await resolveBranch(session.cwd);
      if (branch) this.stmts.setBranch.run(branch, id);
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
