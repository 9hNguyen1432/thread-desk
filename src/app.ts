import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Lifecycle } from './board.js';
import { suggestCleanup, type CleanupSuggestion } from './cleanup.js';
import { saveConfig, type Config } from './config.js';
import { resetIndex, type DB } from './db.js';
import { buildDigest, type Digest } from './digest.js';
import { draftHandoff, handoffTargets, type HandoffTarget } from './handoff.js';
import { hookEffect, hooksInstalled, type HookPayload } from './hooks.js';
import { ticketRegex } from './links.js';
import { fetchAgents } from './live/agents.js';
import { LiveState, type AgentSource } from './live/state.js';
import { generateRecap, buildRecapInput, RecapQueue } from './recap.js';
import { RemoteStatus, type RemoteRef } from './remote/status.js';
import { jiraComment, jiraCreds, parseSlackKey, slackReply, slackToken } from './remote/trackers.js';
import { Searcher } from './search.js';
import { branchName as draftBranch, draftStart, prepareLaunch, type LaunchRequest, type StartDraft } from './start.js';
import { Store, type Card } from './store.js';
import type { TerminalAdapter } from './terminal/types.js';
import { Indexer } from './transcript/indexer.js';
import { TodoService } from './todos/service.js';
import { LabelStore, classifyWithAi, compileRules, resolveLabels } from './labels.js';
import { AskRunner } from './ask.js';
import { displayTitle } from './transcript/parse.js';
import { todoKeys } from './todos/matching.js';

export type BusEvents = {
  board: [];
  toast: [{ message: string; sessionId?: string }];
};

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenResult {
  action: 'focused' | 'opened' | 'copy';
  command: string;
  sessionId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECAP_RECENT_MS = 24 * 3_600_000;

export class ThreadDesk {
  readonly bus = new EventEmitter<BusEvents>();
  readonly store: Store;
  readonly indexer: Indexer;
  readonly live: LiveState;
  readonly remote: RemoteStatus;
  readonly searcher: Searcher;
  readonly recaps: RecapQueue;
  readonly todos: TodoService;
  readonly labels: LabelStore;
  readonly classifier: RecapQueue;
  readonly asks: AskRunner;
  indexing = { running: false, done: 0, total: 0 };
  private reindexPending = false;
  private boardTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly db: DB,
    public config: Config,
    readonly dataDir: string,
    terminal: TerminalAdapter,
    agentSource?: AgentSource,
  ) {
    this.store = new Store(db);
    this.searcher = new Searcher(db);
    this.indexer = new Indexer(db, config.claudeDir, config.links.ticketKeys, {
      sessionsChanged: (ids) => this.onSessionsChanged(ids),
      sessionsReopened: (ids) => {
        for (const id of ids) {
          this.bus.emit('toast', { message: 'Reopened after new activity', sessionId: id });
          void this.live.syncBadges(id);
        }
      },
    });
    this.live = new LiveState(agentSource ?? (() => fetchAgents(config.claudeBin)), terminal, config.pollIntervalMs, (id) => this.store.lifecycleOf(id));
    this.live.on('change', () => this.boardChanged());
    this.remote = new RemoteStatus(db, config, () => this.boardChanged());
    this.todos = new TodoService({
      db,
      config: () => this.config,
      searcher: this.searcher,
      ticketRe: () => this.ticketRe,
      cards: () => this.cards({ includeContinued: true }),
      changed: () => this.boardChanged(),
    });
    this.labels = new LabelStore(db);
    this.asks = new AskRunner(
      db,
      () => this.config,
      (id) => {
        const s = this.store.session(id);
        return s ? { title: displayTitle(s), cwd: s.cwd, file: s.file, transcriptExists: s.transcript_exists === 1 } : null;
      },
      () => this.boardChanged(),
    );
    this.classifier = new RecapQueue(
      (id) => this.runClassify(id),
      () => 100,
    );
    this.recaps = new RecapQueue(
      (id) => this.runRecap(id),
      () => this.config.recap.dailyCap,
    );
  }

  async start(): Promise<void> {
    this.live.start();
    this.indexing = { running: true, done: 0, total: 0 };
    await this.indexer.scanAll((done, total) => {
      this.indexing = { running: true, done, total };
      if (done % 20 === 0) this.boardChanged();
    });
    this.indexing = { ...this.indexing, running: false };
    this.indexer.watch();
    this.replayRecentForTodos();
    this.boardChanged();
    this.runPendingReindex();
  }

  /** Session changes are not routed to todos while indexing, so catch up on recent threads afterwards. */
  private replayRecentForTodos(): void {
    const since = Date.now() - 2 * 86_400_000;
    const rows = this.db.prepare('select id from sessions where last_at >= ?').all(since) as { id: string }[];
    this.todos.onSessionsChanged(rows.map((r) => r.id));
  }

  async stop(): Promise<void> {
    this.live.stop();
    await this.indexer.close();
    this.db.close();
  }

  boardChanged(): void {
    if (this.boardTimer) return;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = null;
      this.bus.emit('board');
    }, 250);
  }

  private onSessionsChanged(ids: string[]): void {
    this.boardChanged();
    if (!this.indexing.running) this.todos.onSessionsChanged(ids);
    if (this.config.labels.ai && !this.indexing.running) {
      const stored = this.labels.all();
      for (const id of ids) {
        if (stored.has(id)) continue;
        const card = this.card(id);
        // Only threads no rule labels; each AI call counts against the daily cap.
        if (card && !card.label && card.lastAt && Date.now() - card.lastAt < 7 * 86_400_000) this.classifier.push(id);
      }
    }
    if (!this.config.recap.enabled || this.indexing.running) return;
    for (const id of ids) {
      const s = this.store.session(id);
      if (!s || !s.last_at || Date.now() - s.last_at > RECAP_RECENT_MS) continue;
      const fresh = s.message_count - this.store.recapMessageCount(id);
      const card = this.card(id);
      if (fresh >= this.config.recap.minNewMessages && card?.live !== 'running') this.recaps.push(id);
    }
  }

  get ticketRe(): RegExp | null {
    return ticketRegex(this.config.links.ticketKeys);
  }

  cards(opts: { project?: string; includeContinued?: boolean } = {}): Card[] {
    return this.decorate(this.store.cards(opts, this.live.snapshot, this.live.hooks));
  }

  /** Adds what lives outside the session index: todo links and labels. */
  private decorate(cards: Card[]): Card[] {
    const todos = this.todos.todosBySession();
    const labels = resolveLabels(this.labels.all(), compileRules(this.config.labels.rules, this.config.labels.names), cards);
    for (const card of cards) {
      card.todos = todos.get(card.id) ?? [];
      card.label = labels.get(card.id) ?? null;
    }
    return cards;
  }

  setLabel(id: string, name: string | null): void {
    this.requireCard(id);
    if (name !== null && name !== '' && !this.config.labels.names.includes(name)) throw new HttpError(400, 'Unknown label');
    this.labels.set(id, name, 'manual');
    this.boardChanged();
  }

  private async runClassify(id: string): Promise<void> {
    const card = this.card(id);
    if (!card || card.label) return;
    // Explicit choices (including "no label") are never overwritten by a guess.
    const name = await classifyWithAi(this.config, this.dataDir, this.config.labels.names, card);
    this.labels.set(id, name ?? '', 'ai');
    this.boardChanged();
  }

  card(id: string): Card | null {
    const card = this.store.card(id, this.live.snapshot, this.live.hooks);
    return card ? this.decorate([card])[0]! : null;
  }

  requireCard(id: string): Card {
    if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid session id');
    const card = this.card(id);
    if (!card) throw new HttpError(404, 'Session not found');
    return card;
  }

  /** Statuses we show on cards: PRs created by live threads and tickets of live threads. */
  refreshRemoteFor(cards: Card[]): void {
    const refs: RemoteRef[] = [];
    for (const card of cards) {
      if (!card.tab && !card.agent) continue;
      for (const l of card.links) {
        if ((l.kind === 'pr' && l.source === 'pr-link') || l.kind === 'issue' || (l.kind === 'ticket' && l.key === card.primaryTicket)) {
          refs.push({ kind: l.kind, key: l.key, url: l.url });
        }
      }
    }
    void this.remote.refresh(refs);
  }

  async setLifecycle(id: string, lifecycle: Lifecycle): Promise<{ card: Card; closePrompt: Card['tab']; closed: boolean }> {
    this.requireCard(id);
    this.store.setLifecycle(id, lifecycle);
    await this.live.syncBadges(id);
    this.boardChanged();
    let card = this.requireCard(id);
    let closePrompt: Card['tab'] = null;
    let closed = false;
    if (lifecycle === 'done' && card.tab && !card.closeBlock) {
      if (this.config.onDone === 'ask') closePrompt = card.tab;
      else if (this.config.onDone === 'close') {
        await this.closeTab(id);
        closed = true;
        card = this.requireCard(id);
      }
    }
    return { card, closePrompt, closed };
  }

  /** Re-checks against a fresh snapshot so a decision made on stale data never closes busy work. */
  async closeTab(id: string): Promise<void> {
    await this.live.refresh();
    const card = this.requireCard(id);
    if (!card.tab) throw new HttpError(404, 'No open terminal tab for this thread');
    if (card.closeBlock) throw new HttpError(409, card.closeBlock);
    const tab = this.live.snapshot.tabs.find((t) => t.ref === card.tab!.ref);
    if (!tab) throw new HttpError(404, 'Tab is gone');
    await this.live.terminal.close(tab);
    await this.live.refresh();
    this.boardChanged();
  }

  resumeCommand(sessionId: string): string {
    return this.config.resumeCommand.replace(/\{sessionId\}/g, sessionId);
  }

  async open(id: string): Promise<OpenResult> {
    this.requireCard(id);
    const target = this.store.latestInChain(id);
    const card = this.requireCard(target);
    const command = this.resumeCommand(target);
    const copy = (): OpenResult => ({
      action: 'copy',
      command: card.cwd ? `cd '${card.cwd.replace(/'/g, `'\\''`)}' && ${command}` : command,
      sessionId: target,
    });
    if (card.tab) {
      const tab = this.live.snapshot.tabs.find((t) => t.ref === card.tab!.ref);
      if (tab) {
        await this.live.terminal.focus(tab);
        return { action: 'focused', command, sessionId: target };
      }
    }
    if (card.agent?.pid) {
      throw new HttpError(409, `This session is already running in another terminal (pid ${card.agent.pid}); switch to it there`);
    }
    if (!card.transcriptExists) throw new HttpError(409, 'Transcript was deleted by Claude Code (cleanupPeriodDays); it cannot be resumed');
    if (this.live.terminal.name === 'none' || !card.cwd || !existsSync(card.cwd)) return copy();
    await this.live.terminal.open({ cwd: card.cwd, title: card.title, command });
    void this.live.refresh();
    return { action: 'opened', command, sessionId: target };
  }

  search(q: string): SearchResult[] {
    const cards = this.cards({ includeContinued: true });
    const byId = new Map(cards.map((c) => [c.id, c]));
    const titles = new Map(cards.map((c) => [c.id, c.title]));
    const projectFilter = /(?:^|\s)project:(\S+)/i.exec(q)?.[1]?.toLowerCase();
    const isFilter = /(?:^|\s)is:(\S+)/i.exec(q)?.[1]?.toLowerCase();
    const results: SearchResult[] = [];
    for (const hit of this.searcher.search(q, this.ticketRe, titles, 1000)) {
      if (results.length >= 40) break;
      const card = byId.get(hit.sessionId);
      if (!card) continue;
      if (projectFilter && !(card.projectName ?? '').toLowerCase().includes(projectFilter)) continue;
      if (isFilter && !card.column.startsWith(isFilter) && !card.lifecycle.startsWith(isFilter)) continue;
      results.push({ card, matchedBy: hit.matchedBy, snippet: hit.snippet });
    }
    return results;
  }

  inbox(): Card[] {
    const now = Date.now();
    return this.cards()
      .filter((c) => c.column === 'needs_you' && !(c.snoozedUntil && c.snoozedUntil > now))
      .sort((a, b) => (a.lastAssistantAt ?? a.lastAt ?? 0) - (b.lastAssistantAt ?? b.lastAt ?? 0));
  }

  cleanup(): CleanupSuggestion[] {
    const cards = this.cards();
    this.refreshRemoteFor(cards);
    return suggestCleanup(cards, this.config.cleanup, Date.now());
  }

  async closeMany(ids: string[], markDone: boolean): Promise<{ sessionId: string; ok: boolean; error?: string }[]> {
    const results: { sessionId: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await this.closeTab(id);
        if (markDone) this.store.setLifecycle(id, 'done');
        results.push({ sessionId: id, ok: true });
      } catch (e) {
        results.push({ sessionId: id, ok: false, error: (e as Error).message });
      }
    }
    this.boardChanged();
    return results;
  }

  tickets(): TicketGroup[] {
    const cards = this.cards({ includeContinued: true });
    const groups = new Map<string, TicketGroup>();
    for (const card of cards) {
      for (const link of card.links) {
        if (link.kind !== 'ticket') continue;
        const g = groups.get(link.key) ?? {
          key: link.key,
          title: link.title,
          state: link.state,
          category: link.category,
          url: link.url,
          lastAt: 0,
          threads: [],
          prs: [],
          slack: [],
          figma: [],
        };
        g.threads.push({ id: card.id, title: card.title, column: card.column, lifecycle: card.lifecycle, lastAt: card.lastAt });
        g.lastAt = Math.max(g.lastAt, card.lastAt ?? 0);
        for (const l of card.links) {
          const bucket = l.kind === 'pr' ? g.prs : l.kind === 'slack' ? g.slack : l.kind === 'figma' ? g.figma : null;
          if (bucket && !bucket.some((x) => x.key === l.key)) bucket.push({ key: l.key, url: l.url, state: l.state });
        }
        groups.set(link.key, g);
      }
    }
    const list = [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
    void this.remote.refresh(list.slice(0, 100).map((g) => ({ kind: 'ticket', key: g.key, url: g.url })));
    void this.remote.refresh(list.slice(0, 100).flatMap((g) => g.prs.map((p) => ({ kind: 'pr' as const, key: p.key, url: p.url }))));
    return list;
  }

  digest(from: number, to: number): Digest {
    return buildDigest(this.db, this.cards({ includeContinued: true }), from, to);
  }

  async recapNow(id: string): Promise<void> {
    this.requireCard(id);
    if (!this.recaps.push(id)) throw new HttpError(409, 'Recap already queued or daily cap reached');
  }

  private async runRecap(id: string): Promise<void> {
    const session = this.store.session(id);
    if (!session) return;
    const messages = this.store.messages(id, 14);
    const input = buildRecapInput(session.first_prompt, messages);
    const recap = await generateRecap(this.config.claudeBin, this.config.recap.model, this.dataDir, input);
    this.store.setRecap(id, recap, session.message_count);
    this.boardChanged();
  }

  async startDraft(input: string): Promise<StartDraft> {
    if (!input.trim()) throw new HttpError(400, 'Paste a ticket key or link');
    return draftStart(input, this.config, this.remote);
  }

  /** A start-thread draft prefilled from a todo, so the new thread links back to it on its own. */
  async todoStartDraft(todoId: number): Promise<StartDraft> {
    const todo = this.todos.store.get(todoId);
    if (!todo) throw new HttpError(404, 'Todo not found');
    const anchor = todoKeys(todo, this.ticketRe).find((k) => k.kind === 'ticket' || k.kind === 'issue' || k.kind === 'slack');
    const base = anchor ? await draftStart(anchor.url ?? anchor.key, this.config, this.remote) : null;
    const prompt = [todo.title, todo.notes, base?.description && base.description !== todo.notes ? base.description : null]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join('\n\n');
    return {
      key: base?.key ?? null,
      title: todo.title,
      url: base?.url ?? null,
      description: base?.description ?? '',
      branch: base?.branch ?? draftBranch(this.config.start.branch, null, todo.title),
      prompt,
      warnings: base?.warnings ?? [],
    };
  }

  async launch(req: LaunchRequest, todoId?: number): Promise<{ dir: string; command: string; opened: boolean }> {
    if (!req.title.trim() || !req.prompt.trim()) throw new HttpError(400, 'Title and prompt are required');
    let prepared;
    try {
      prepared = await prepareLaunch(req, this.config, this.dataDir);
    } catch (e) {
      throw new HttpError(422, (e as Error).message);
    }
    if (todoId !== undefined) this.todos.registerLaunch(todoId, prepared.dir, req.prompt);
    if (this.live.terminal.name === 'none') {
      return { ...prepared, command: `cd '${prepared.dir.replace(/'/g, `'\\''`)}' && ${prepared.command}`, opened: false };
    }
    await this.live.terminal.open({ cwd: prepared.dir, title: req.title, command: prepared.command });
    void this.live.refresh();
    return { ...prepared, opened: true };
  }

  handoff(id: string): { draft: string; targets: HandoffTarget[] } {
    const card = this.requireCard(id);
    const jira = jiraCreds(this.config.trackers.jira.site) !== null;
    return { draft: draftHandoff(card), targets: handoffTargets(card, jira, slackToken() !== null) };
  }

  async postHandoff(id: string, target: { kind: string; key: string }, text: string): Promise<void> {
    const { targets } = this.handoff(id);
    if (!text.trim()) throw new HttpError(400, 'Empty message');
    if (!targets.some((t) => t.kind === target.kind && t.key === target.key)) throw new HttpError(400, 'Unknown target');
    if (target.kind === 'jira') {
      await jiraComment(jiraCreds(this.config.trackers.jira.site)!, target.key, text);
    } else {
      const ref = parseSlackKey(target.key);
      if (!ref) throw new HttpError(400, 'Bad Slack reference');
      await slackReply(slackToken()!, ref.channel, ref.ts, text);
    }
  }

  async handleHook(payload: HookPayload): Promise<void> {
    const effect = hookEffect(payload, Date.now());
    if (effect.kind === 'set') this.live.setHook(effect.sessionId, effect.state);
    if (effect.kind === 'clear') this.live.setHook(effect.sessionId, null);
    if (payload.transcript_path) void this.indexer.syncPath(payload.transcript_path).catch(() => undefined);
    if (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'SessionEnd') void this.live.refresh();
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    const next = structuredClone(this.config);
    if (patch.ticketKeys) next.links.ticketKeys = [...new Set(patch.ticketKeys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]{0,9}$/.test(k)))];
    if (patch.onDone) next.onDone = patch.onDone;
    if (patch.idleHours !== undefined) next.cleanup.idleHours = Math.max(0, Math.round(patch.idleHours));
    if (patch.recapEnabled !== undefined) next.recap.enabled = patch.recapEnabled;
    if (patch.jiraSite !== undefined) next.trackers.jira.site = patch.jiraSite.trim();
    if (patch.labelNames) {
      next.labels.names = [...new Set(patch.labelNames.map((n) => n.trim()).filter((n) => n && n.length <= 30))].slice(0, 20);
    }
    if (patch.labelsAi !== undefined) next.labels.ai = patch.labelsAi;
    const keysChanged = JSON.stringify(next.links.ticketKeys) !== JSON.stringify(this.config.links.ticketKeys);
    this.config = next;
    this.remote.setConfig(next);
    saveConfig(this.dataDir, next);
    if (keysChanged) void this.reindex();
    this.boardChanged();
  }

  /** Never rejects: failures are reported through status, so callers may fire and forget. */
  async reindex(): Promise<void> {
    if (this.indexing.running) {
      this.reindexPending = true;
      return;
    }
    this.indexing = { running: true, done: 0, total: 0 };
    try {
      await this.rebuildIndex();
    } catch (e) {
      this.bus.emit('toast', { message: `Re-reading transcripts failed: ${(e as Error).message}` });
    } finally {
      this.indexing = { ...this.indexing, running: false };
      this.boardChanged();
      this.runPendingReindex();
    }
  }

  private runPendingReindex(): void {
    if (!this.reindexPending) return;
    this.reindexPending = false;
    void this.reindex();
  }

  private async rebuildIndex(): Promise<void> {
    this.indexer.setTicketKeys(this.config.links.ticketKeys);
    await this.indexer.exclusive(async () => resetIndex(this.db));
    this.boardChanged();
    await this.indexer.scanAll((done, total) => {
      this.indexing = { running: true, done, total };
    });
    this.replayRecentForTodos();
  }

  retentionDays(): number {
    try {
      const settings = JSON.parse(readFileSync(join(this.config.claudeDir, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: number };
      return typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : 30;
    } catch {
      return 30;
    }
  }

  async status() {
    return {
      terminal: this.live.terminal.name,
      integrations: await this.remote.integrations(),
      hooksInstalled: hooksInstalled(this.config.claudeDir),
      indexing: this.indexing,
      indexErrors: this.indexer.errors.size,
      liveErrors: this.live.snapshot.errors,
      retentionDays: this.retentionDays(),
      ticketKeys: this.config.links.ticketKeys,
      ticketKeySuggestions: this.store.ticketPrefixSuggestions(this.config.links.ticketKeys),
      onDone: this.config.onDone,
      idleHours: this.config.cleanup.idleHours,
      recap: { enabled: this.config.recap.enabled, remainingToday: this.recaps.remainingToday },
      jiraSite: this.config.trackers.jira.site,
      labels: { names: this.config.labels.names, ai: this.config.labels.ai },
      ask: { model: this.config.ask.model, templates: this.config.ask.templates },
      projects: this.store.projects(),
    };
  }
}

export interface SearchResult {
  card: Card;
  matchedBy: 'link' | 'title' | 'text';
  snippet: string | null;
}

export interface TicketGroup {
  key: string;
  title: string | null;
  state: string | null;
  category: string | null;
  url: string | null;
  lastAt: number;
  threads: { id: string; title: string; column: string; lifecycle: string; lastAt: number | null }[];
  prs: { key: string; url: string | null; state: string | null }[];
  slack: { key: string; url: string | null; state: string | null }[];
  figma: { key: string; url: string | null; state: string | null }[];
}

export interface SettingsPatch {
  labelNames?: string[];
  labelsAi?: boolean;
  ticketKeys?: string[];
  onDone?: Config['onDone'];
  idleHours?: number;
  recapEnabled?: boolean;
  jiraSite?: string;
}

