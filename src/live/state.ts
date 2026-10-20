import { EventEmitter } from 'node:events';
import { badgeFor, type HookState, type Lifecycle } from '../board.js';
import type { Tab, TerminalAdapter } from '../terminal/types.js';
import { fetchAgents, type AgentInfo } from './agents.js';

export interface LiveSnapshot {
  agents: Map<string, AgentInfo>;
  tabs: Tab[];
  tabBySession: Map<string, Tab>;
  sessionByTab: Map<string, string>;
  terminal: TerminalAdapter['name'];
  errors: string[];
  at: number;
}

export type LifecycleLookup = (sessionId: string) => { lifecycle: Lifecycle; note: string | null };

const BINDING_TTL_MS = 60_000;

function emptySnapshot(terminal: TerminalAdapter['name']): LiveSnapshot {
  return {
    agents: new Map(),
    tabs: [],
    tabBySession: new Map(),
    sessionByTab: new Map(),
    terminal,
    errors: [],
    at: 0,
  };
}

export class LiveState extends EventEmitter<{ change: [] }> {
  snapshot: LiveSnapshot;
  readonly hooks = new Map<string, HookState>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private signature = '';
  private readonly bindings = new Map<string, { pid: number | null; sessionId: string | null; at: number }>();
  private readonly appliedBadges = new Map<string, string>();

  constructor(
    private readonly claudeBin: string | null,
    readonly terminal: TerminalAdapter,
    private readonly intervalMs: number,
    private readonly lookupLifecycle: LifecycleLookup,
  ) {
    super();
    this.snapshot = emptySnapshot(terminal.name);
  }

  start(): void {
    const tick = () => {
      void this.refresh().finally(() => {
        this.timer = setTimeout(tick, this.intervalMs);
      });
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const errors: string[] = [];
    const agents = await (this.claudeBin ? fetchAgents(this.claudeBin) : Promise.resolve([])).catch((e: Error) => {
      errors.push(`claude agents: ${e.message}`);
      return [] as AgentInfo[];
    });
    const tabs = await this.terminal.listTabs().catch((e: Error) => {
      errors.push(`${this.terminal.name}: ${e.message}`);
      return [] as Tab[];
    });

    const agentsBySession = new Map(agents.map((a) => [a.sessionId, a]));
    const agentsByPid = new Map(agents.filter((a) => a.pid !== null).map((a) => [a.pid!, a]));
    const tabBySession = new Map<string, Tab>();
    const sessionByTab = new Map<string, string>();
    const now = Date.now();

    // Tabs whose Claude process is matched by pid win over tabs matched only by a stored resume
    // binding, which can point at a session that has since moved to another tab.
    const byBinding: [Tab, string][] = [];
    for (const tab of tabs) {
      const byPid = tab.claudePid !== null ? agentsByPid.get(tab.claudePid)?.sessionId : undefined;
      if (byPid) {
        if (!tabBySession.has(byPid)) {
          tabBySession.set(byPid, tab);
          sessionByTab.set(tab.ref, byPid);
        }
        continue;
      }
      const cached = this.bindings.get(tab.ref);
      let sessionId: string | null;
      if (cached && cached.pid === tab.claudePid && now - cached.at < BINDING_TTL_MS) {
        sessionId = cached.sessionId;
      } else {
        sessionId = await this.terminal.sessionIdForTab(tab);
        this.bindings.set(tab.ref, { pid: tab.claudePid, sessionId, at: now });
      }
      if (sessionId) byBinding.push([tab, sessionId]);
    }
    for (const [tab, sessionId] of byBinding) {
      if (tabBySession.has(sessionId)) continue;
      tabBySession.set(sessionId, tab);
      sessionByTab.set(tab.ref, sessionId);
    }
    const liveRefs = new Set(tabs.map((t) => t.ref));
    for (const ref of this.bindings.keys()) if (!liveRefs.has(ref)) this.bindings.delete(ref);
    for (const ref of this.appliedBadges.keys()) if (!liveRefs.has(ref)) this.appliedBadges.delete(ref);

    this.snapshot = { agents: agentsBySession, tabs, tabBySession, sessionByTab, terminal: this.terminal.name, errors, at: now };
    await this.syncBadges();

    const signature = JSON.stringify([
      agents.map((a) => [a.sessionId, a.status, a.state, a.waitingFor, a.pid]),
      tabs.map((t) => [t.ref, t.title, t.agentStatus, sessionByTab.get(t.ref), Math.round(t.memoryBytes / 50e6)]),
      errors,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.emit('change');
    }
  }

  async syncBadges(onlySession?: string): Promise<void> {
    for (const [sessionId, tab] of this.snapshot.tabBySession) {
      if (onlySession && sessionId !== onlySession) continue;
      const { lifecycle, note } = this.lookupLifecycle(sessionId);
      const badge = badgeFor(lifecycle, note);
      const key = badge ? `${badge.icon}|${badge.text}` : '';
      // Unknown (first sight of a tab) is never equal to a key, so stale badges left by
      // a previous run are cleared once.
      const applied = this.appliedBadges.get(tab.ref);
      if (applied === key) continue;
      try {
        await this.terminal.setBadge(tab, badge);
        this.appliedBadges.set(tab.ref, key);
      } catch {
        // Badges are cosmetic; the next poll retries.
      }
    }
  }

  setHook(sessionId: string, state: HookState | null): void {
    if (state) this.hooks.set(sessionId, state);
    else this.hooks.delete(sessionId);
    this.emit('change');
  }
}
