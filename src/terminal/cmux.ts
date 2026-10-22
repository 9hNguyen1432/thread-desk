import { platform } from 'node:os';
import { agentOfProcess, isAgentKind, sessionIdInCommand, type AgentKind } from '../agents.js';
import { run, runJson, type RunError } from '../exec.js';
import { listProcesses, SHELLS, type ProcInfo } from './processes.js';
import type { LiveStatus, OpenOptions, Tab, TerminalAdapter } from './types.js';

interface CmuxTag {
  key?: string;
  value?: string;
  pid?: number | null;
}

export interface CmuxProcess {
  pid?: number;
  pgid?: number;
  name?: string;
  path?: string | null;
  children?: CmuxProcess[];
}

interface CmuxSurface {
  type?: string;
  foreground_pgids?: number[];
  processes?: CmuxProcess[];
}

interface CmuxTopWorkspace {
  ref?: string;
  title?: string;
  resources?: { memory_bytes?: number; cpu_percent?: number };
  tags?: CmuxTag[];
  panes?: { surfaces?: CmuxSurface[] }[];
}

interface CmuxTop {
  windows?: { ref?: string; workspaces?: CmuxTopWorkspace[] }[];
}

interface CmuxWorkspaceList {
  workspaces?: { ref?: string; current_directory?: string | null }[];
}

interface CmuxResume {
  resume_binding?: { kind?: string; checkpoint_id?: string | null } | null;
}

const BADGE_KEY = 'thread_desk';

export function cmuxStatus(value: string | undefined): LiveStatus | null {
  switch (value?.trim().toLowerCase()) {
    case 'running':
      return 'running';
    case 'needs input':
      return 'needs_you';
    case 'idle':
      return 'idle';
    default:
      return null;
  }
}

function flatten(processes: CmuxProcess[] | undefined): CmuxProcess[] {
  const out: CmuxProcess[] = [];
  const walk = (list: CmuxProcess[] | undefined) => {
    for (const p of list ?? []) {
      out.push(p);
      walk(p.children);
    }
  };
  walk(processes);
  return out;
}

function isShell(p: CmuxProcess): boolean {
  return SHELLS.has((p.name ?? '').replace(/^-/, ''));
}

export interface WorkspaceAgent {
  agentPid: number | null;
  agentKind: AgentKind | null;
  agentStartedAt: number | null;
  agentSessionHint: string | null;
  closeBlock: string | null;
}

/** Foreground process-group leaders of a workspace's only terminal; empty for splits and browsers. */
export function foregroundLeaders(ws: CmuxTopWorkspace): CmuxProcess[] {
  const surfaces = (ws.panes ?? []).flatMap((p) => p.surfaces ?? []);
  if (surfaces.length !== 1) return [];
  const foreground = new Set(surfaces[0]!.foreground_pgids ?? []);
  return flatten(surfaces[0]!.processes).filter((p) => p.pid !== undefined && foreground.has(p.pid));
}

/**
 * A workspace is only safe to close when its single terminal is in the foreground of a coding agent
 * or of an idle shell. Splits, extra tabs, browsers or any other foreground program (a dev server,
 * an editor) would be killed along with it. `procs` adds command lines for agents started by node.
 */
export function inspectWorkspace(ws: CmuxTopWorkspace, procs: Map<number, ProcInfo> = new Map()): WorkspaceAgent {
  const surfaces = (ws.panes ?? []).flatMap((p) => p.surfaces ?? []);
  const tagPid = ws.tags?.find((t) => t.key === 'claude_code')?.pid;
  const found: WorkspaceAgent = {
    agentPid: typeof tagPid === 'number' ? tagPid : null,
    agentKind: typeof tagPid === 'number' ? 'claude' : null,
    agentStartedAt: typeof tagPid === 'number' ? (procs.get(tagPid)?.startedAt ?? null) : null,
    agentSessionHint: typeof tagPid === 'number' ? sessionIdInCommand(procs.get(tagPid)?.command) : null,
    closeBlock: null,
  };
  if (surfaces.length !== 1) {
    return { ...found, closeBlock: `This workspace has ${surfaces.length} panes or tabs; close it in cmux instead` };
  }
  const surface = surfaces[0]!;
  if (surface.type && surface.type !== 'terminal') return { ...found, closeBlock: 'This tab is not a terminal' };
  const leaders = foregroundLeaders(ws).map((p) => ({ p, kind: agentOfProcess({ ...p, command: procs.get(p.pid!)?.command }) }));
  const agent = leaders.find((l) => l.kind !== null);
  if (found.agentPid === null && agent) {
    found.agentPid = agent.p.pid!;
    found.agentKind = agent.kind;
    found.agentStartedAt = procs.get(agent.p.pid!)?.startedAt ?? null;
    found.agentSessionHint = sessionIdInCommand(procs.get(agent.p.pid!)?.command);
  }
  if (leaders.length === 0) return { ...found, closeBlock: 'Cannot tell what is running in this tab' };
  const other = leaders.find((l) => l.kind === null && !isShell(l.p));
  if (other) return { ...found, closeBlock: `${other.p.name ?? 'Another program'} is running in this tab` };
  return found;
}

export function parseTop(top: CmuxTop, cwdByRef: Map<string, string | null>, procs: Map<number, ProcInfo> = new Map()): Tab[] {
  const tabs: Tab[] = [];
  for (const window of top.windows ?? []) {
    if (!window.ref) continue;
    for (const ws of window.workspaces ?? []) {
      if (!ws.ref) continue;
      const claudeTag = ws.tags?.find((t) => t.key === 'claude_code');
      const { agentPid, agentKind, agentStartedAt, agentSessionHint, closeBlock } = inspectWorkspace(ws, procs);
      tabs.push({
        ref: ws.ref,
        windowRef: window.ref,
        title: ws.title ?? '',
        cwd: cwdByRef.get(ws.ref) ?? null,
        memoryBytes: ws.resources?.memory_bytes ?? 0,
        cpuPercent: ws.resources?.cpu_percent ?? 0,
        agentPid,
        agentKind,
        agentStartedAt,
        agentSessionHint,
        agentStatus: agentKind === 'claude' ? cmuxStatus(claudeTag?.value) : null,
        closeBlock,
      });
    }
  }
  return tabs;
}

export class CmuxAdapter implements TerminalAdapter {
  readonly name = 'cmux' as const;

  constructor(private readonly bin: string) {}

  /**
   * Only a missing binary means "no cmux". A busy or briefly unreachable cmux still gets the
   * adapter; its errors surface as live errors and the next poll recovers.
   */
  static async detect(bin: string): Promise<boolean> {
    try {
      await run(bin, ['ping'], { timeoutMs: 10_000 });
      return true;
    } catch (e) {
      return (e as RunError).code !== 'ENOENT';
    }
  }

  async listTabs(): Promise<Tab[]> {
    const top = await runJson<CmuxTop>(this.bin, ['--json', 'top', '--all', '--processes'], { timeoutMs: 8000 }).catch((e: RunError) => {
      if (/broken pipe|access denied|not allowed|password/i.test(e.stderr ?? '')) {
        throw new Error(
          'cmux refused the connection. Start thread-desk from a cmux tab, or set CMUX_SOCKET_PASSWORD ' +
            '(or socketControlMode) in cmux settings so other processes may control it.',
        );
      }
      throw e;
    });
    const cwdByRef = new Map<string, string | null>();
    for (const window of top.windows ?? []) {
      if (!window.ref) continue;
      const list = await runJson<CmuxWorkspaceList>(this.bin, ['--json', 'list-workspaces', '--window', window.ref], {
        timeoutMs: 5000,
      });
      for (const ws of list.workspaces ?? []) if (ws.ref) cwdByRef.set(ws.ref, ws.current_directory ?? null);
    }
    // cmux only knows executable names; node-based agents are told apart by their command lines.
    const leaderPids = new Set<number>();
    for (const window of top.windows ?? []) {
      for (const ws of window.workspaces ?? []) {
        for (const p of foregroundLeaders(ws)) leaderPids.add(p.pid!);
        const tagPid = ws.tags?.find((t) => t.key === 'claude_code')?.pid;
        if (typeof tagPid === 'number') leaderPids.add(tagPid);
      }
    }
    const procs = await listProcesses([...leaderPids]).catch(() => new Map<number, ProcInfo>());
    return parseTop(top, cwdByRef, procs);
  }

  async sessionIdForTab(tab: Tab): Promise<string | null> {
    try {
      const res = await runJson<CmuxResume>(
        this.bin,
        ['--json', 'surface', 'resume', 'show', '--workspace', tab.ref, '--window', tab.windowRef],
        { timeoutMs: 5000 },
      );
      const binding = res.resume_binding;
      // Only trust a binding for the agent actually running in the tab.
      if (!binding?.checkpoint_id || !isAgentKind(binding.kind)) return null;
      return tab.agentKind === null || tab.agentKind === binding.kind ? binding.checkpoint_id : null;
    } catch {
      return null;
    }
  }

  async focus(tab: Tab): Promise<void> {
    await run(this.bin, ['select-workspace', '--workspace', tab.ref, '--window', tab.windowRef]);
    await this.bringToFront();
  }

  async close(tab: Tab): Promise<void> {
    await run(this.bin, ['close-workspace', '--workspace', tab.ref, '--window', tab.windowRef]);
  }

  async open(opts: OpenOptions): Promise<void> {
    await run(this.bin, ['new-workspace', '--name', opts.title, '--cwd', opts.cwd, '--command', opts.command, '--focus', 'true']);
    await this.bringToFront();
  }

  async setBadge(tab: Tab, badge: { text: string; icon: string } | null): Promise<void> {
    if (badge) {
      await run(this.bin, ['set-status', BADGE_KEY, badge.text, '--workspace', tab.ref, '--window', tab.windowRef, '--icon', badge.icon]);
    } else {
      await run(this.bin, ['clear-status', BADGE_KEY, '--workspace', tab.ref, '--window', tab.windowRef]);
    }
  }

  private async bringToFront(): Promise<void> {
    if (platform() !== 'darwin') return;
    await run('open', ['-a', 'cmux']).catch(() => undefined);
  }
}
