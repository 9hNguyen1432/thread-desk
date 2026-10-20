import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentInfo } from './live/agents.js';
import type { LiveStatus, OpenOptions, Tab, TerminalAdapter } from './terminal/types.js';

interface DemoSession {
  live?: { status: LiveStatus; memoryMb: number };
  cwd: string;
  branch: string;
  title: string;
  hoursAgo: number;
  turns: [string, string][];
  pr?: number;
}

const SESSIONS: DemoSession[] = [
  {
    cwd: '/work/acme-api',
    branch: 'feat/demo-101-rate-limit',
    title: 'Add rate limiting to public API',
    hoursAgo: 0.2,
    pr: 412,
    live: { status: 'needs_you', memoryMb: 640 },
    turns: [
      ['Implement DEMO-101: add per-user rate limiting to the public API', 'I added a token-bucket limiter in middleware/rate-limit.ts and opened https://github.com/acme/api/pull/412.'],
      ['Should the limit be per API key or per user?', 'Per user is safer for shared keys. Want me to switch it?'],
    ],
  },
  {
    cwd: '/work/acme-app',
    branch: 'fix/demo-87-login-crash',
    title: 'Login crash on Android 14',
    hoursAgo: 0.05,
    live: { status: 'running', memoryMb: 410 },
    turns: [
      ['DEMO-87 login crashes on Android 14, logs in https://acme.slack.com/archives/C024BE91L/p1729400000123456', 'The crash comes from a null biometric prompt. Fixed in LoginScreen.tsx.'],
    ],
  },
  {
    cwd: '/work/acme-app',
    branch: 'feat/demo-120-onboarding',
    title: 'Onboarding redesign from Figma',
    hoursAgo: 30,
    turns: [
      ['Build the new onboarding from https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Onboarding?node-id=12-34 (DEMO-120)', 'Implemented steps 1 to 3; step 4 needs the final copy from design.'],
    ],
  },
  {
    cwd: '/work/acme-api',
    branch: 'main',
    title: 'Investigate slow /search endpoint',
    hoursAgo: 52,
    live: { status: 'idle', memoryMb: 930 },
    turns: [
      ['Why is /search slow since Monday?', 'A missing index on jobs(created_at). Adding it drops p95 from 2.1s to 180ms.'],
      ['ok ship it', 'Opened https://github.com/acme/api/pull/398 with the migration.'],
    ],
    pr: 398,
  },
  {
    cwd: '/work/acme-infra',
    branch: 'chore/demo-64-upgrade-node',
    title: 'Upgrade services to Node 24',
    hoursAgo: 200,
    turns: [['Upgrade all services to Node 24 for DEMO-64', 'Done for api and worker; the web build needs a Vite bump.']],
  },
];

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

export interface DemoTab {
  sessionId: string;
  title: string;
  cwd: string;
  status: LiveStatus;
  memoryBytes: number;
}

/** Writes a throwaway ~/.claude-like directory with realistic sample transcripts. */
export function createDemoClaudeDir(dataDir: string): { claudeDir: string; tabs: DemoTab[] } {
  const tabs: DemoTab[] = [];
  const root = join(dataDir, 'demo-claude');
  rmSync(root, { recursive: true, force: true });
  const now = Date.now();
  for (const s of SESSIONS) {
    const id = randomUUID();
    const dir = join(root, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    let ts = now - s.hoursAgo * 3_600_000 - s.turns.length * 120_000;
    let out = line({ type: 'custom-title', customTitle: s.title, sessionId: id });
    for (const [user, assistant] of s.turns) {
      const base = { cwd: s.cwd, gitBranch: s.branch, sessionId: id, version: 'demo', isSidechain: false };
      out += line({ ...base, type: 'user', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: user } });
      ts += 60_000;
      out += line({
        ...base,
        type: 'assistant',
        timestamp: new Date(ts).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: assistant }] },
      });
      ts += 60_000;
    }
    if (s.pr) {
      out += line({
        type: 'pr-link',
        sessionId: id,
        prNumber: s.pr,
        prUrl: `https://github.com/acme/api/pull/${s.pr}`,
        prRepository: 'acme/api',
        timestamp: new Date(ts).toISOString(),
      });
    }
    writeFileSync(join(dir, `${id}.jsonl`), out);
    if (s.live) tabs.push({ sessionId: id, title: s.title, cwd: s.cwd, status: s.live.status, memoryBytes: s.live.memoryMb * 1e6 });
  }
  return { claudeDir: root, tabs };
}

/** Pretends to be a terminal with a few open tabs so the demo shows live columns. */
export class DemoAdapter implements TerminalAdapter {
  readonly name = 'cmux' as const;
  private tabs: DemoTab[];

  constructor(tabs: DemoTab[]) {
    this.tabs = [...tabs];
  }

  private toTab(t: DemoTab, i: number): Tab {
    return {
      ref: `workspace:${i + 1}`,
      windowRef: 'window:1',
      title: t.title,
      cwd: t.cwd,
      memoryBytes: t.memoryBytes,
      cpuPercent: 0,
      claudePid: 100_000 + i,
      agentStatus: t.status,
      closeBlock: null,
    };
  }

  async listTabs(): Promise<Tab[]> {
    return this.tabs.map((t, i) => this.toTab(t, i));
  }

  async sessionIdForTab(tab: Tab): Promise<string | null> {
    return this.tabs.find((t) => t.title === tab.title)?.sessionId ?? null;
  }

  async focus(): Promise<void> {}

  async close(tab: Tab): Promise<void> {
    this.tabs = this.tabs.filter((t) => t.title !== tab.title);
  }

  async open(opts: OpenOptions): Promise<void> {
    this.tabs.push({ sessionId: /--resume (\S+)/.exec(opts.command)?.[1] ?? '', title: opts.title, cwd: opts.cwd, status: 'idle', memoryBytes: 300e6 });
  }

  async setBadge(): Promise<void> {}

  /** What `claude agents --json` would report for the open demo tabs. */
  async agents(): Promise<AgentInfo[]> {
    return this.tabs.map((t, i) => ({
      sessionId: t.sessionId,
      pid: 100_000 + i,
      kind: 'interactive',
      status: t.status === 'running' ? 'busy' : 'idle',
      state: null,
      waitingFor: null,
      name: t.title,
      cwd: t.cwd,
      startedAt: null,
    }));
  }
}
