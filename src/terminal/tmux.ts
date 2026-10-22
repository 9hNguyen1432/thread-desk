import { agentOfProcess, sessionIdInCommand } from '../agents.js';
import { run, type RunError } from '../exec.js';
import { listProcesses, processTree, SHELLS, type ProcInfo } from './processes.js';
import type { OpenOptions, Tab, TerminalAdapter } from './types.js';

/** Pane fields, tab separated; the order matches `parsePanes`. */
const PANE_FORMAT = ['#{session_name}', '#{window_id}', '#{window_index}', '#{window_name}', '#{window_panes}', '#{pane_pid}', '#{pane_current_path}'].join('\t');

export interface TmuxPane {
  session: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  windowPanes: number;
  panePid: number;
  cwd: string;
}

export function parsePanes(stdout: string): TmuxPane[] {
  const out: TmuxPane[] = [];
  for (const line of stdout.split('\n')) {
    const f = line.split('\t');
    if (f.length < 7 || !f[1]!.startsWith('@')) continue;
    out.push({
      session: f[0]!,
      windowId: f[1]!,
      windowIndex: f[2]!,
      windowName: f[3]!,
      windowPanes: Number(f[4]),
      panePid: Number(f[5]),
      cwd: f[6]!,
    });
  }
  return out;
}

/**
 * A tmux window is one tab. It is only safe to close when it has a single pane whose foreground is a
 * coding agent or an idle shell; the foreground is the process group the pane's terminal points at.
 */
export function windowTabs(panes: TmuxPane[], procs: Map<number, ProcInfo>, selfPid = process.pid): Tab[] {
  const tabs: Tab[] = [];
  const seen = new Set<string>();
  for (const pane of panes) {
    if (seen.has(pane.windowId)) continue;
    seen.add(pane.windowId);
    const tree = processTree(procs, pane.panePid);
    const shell = procs.get(pane.panePid);
    const leader = shell ? procs.get(shell.tpgid) : undefined;
    const kind = leader ? agentOfProcess(leader) : null;
    let closeBlock: string | null = null;
    if (pane.windowPanes !== 1) closeBlock = `This window has ${pane.windowPanes} panes; close it in tmux instead`;
    else if (tree.some((p) => p.pid === selfPid)) closeBlock = 'Thread Desk is running in this window';
    else if (!shell || !leader) closeBlock = 'Cannot tell what is running in this window';
    else if (!kind && !SHELLS.has(leader.name)) closeBlock = `${leader.name} is running in this window`;
    tabs.push({
      ref: pane.windowId,
      windowRef: pane.session,
      title: `${pane.session}:${pane.windowIndex} ${pane.windowName}`,
      cwd: pane.cwd || null,
      memoryBytes: tree.reduce((sum, p) => sum + p.rssBytes, 0),
      cpuPercent: tree.reduce((sum, p) => sum + p.cpuPercent, 0),
      agentPid: kind ? leader!.pid : null,
      agentKind: kind,
      agentStartedAt: kind ? leader!.startedAt : null,
      agentSessionHint: kind ? sessionIdInCommand(leader!.command) : null,
      agentStatus: null,
      closeBlock,
    });
  }
  return tabs;
}

const BADGE_OPTION = '@thread_desk';

export class TmuxAdapter implements TerminalAdapter {
  readonly name = 'tmux' as const;

  constructor(private readonly bin: string) {}

  /** A tmux server must be running; tmux only exists while it has sessions. */
  static async detect(bin: string): Promise<boolean> {
    try {
      await run(bin, ['list-sessions'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async listTabs(): Promise<Tab[]> {
    const { stdout } = await run(this.bin, ['list-panes', '-a', '-F', PANE_FORMAT], { timeoutMs: 5000 }).catch((e: RunError) => {
      if (/no server running|error connecting/i.test(e.stderr)) return { stdout: '' };
      throw e;
    });
    const panes = parsePanes(stdout);
    if (panes.length === 0) return [];
    return windowTabs(panes, await listProcesses());
  }

  async sessionIdForTab(): Promise<string | null> {
    return null;
  }

  async focus(tab: Tab): Promise<void> {
    await run(this.bin, ['select-window', '-t', tab.ref]);
    // Moves an attached client to that session too; there may be no client to move.
    await run(this.bin, ['switch-client', '-t', tab.ref]).catch(() => undefined);
  }

  async close(tab: Tab): Promise<void> {
    await run(this.bin, ['kill-window', '-t', tab.ref]);
  }

  /** Types the command into a fresh shell, so the window stays open after the agent exits. */
  async open(opts: OpenOptions): Promise<void> {
    const target = process.env.TMUX ? [] : ['-t', await this.firstSession()];
    const { stdout } = await run(this.bin, ['new-window', ...target, '-P', '-F', '#{window_id}', '-c', opts.cwd, '-n', opts.title.slice(0, 40)]);
    const windowId = stdout.trim();
    await run(this.bin, ['send-keys', '-t', windowId, '-l', opts.command]);
    await run(this.bin, ['send-keys', '-t', windowId, 'Enter']);
    await this.focus({ ref: windowId } as Tab);
  }

  async setBadge(tab: Tab, badge: { text: string; icon: string } | null): Promise<void> {
    if (badge) await run(this.bin, ['set-option', '-w', '-t', tab.ref, BADGE_OPTION, badge.text]);
    else await run(this.bin, ['set-option', '-w', '-u', '-t', tab.ref, BADGE_OPTION]);
  }

  private async firstSession(): Promise<string> {
    const { stdout } = await run(this.bin, ['list-sessions', '-F', '#{session_name}']);
    const name = stdout.split('\n').find(Boolean);
    if (!name) throw new Error('No tmux session to open a window in');
    return `${name}:`;
  }
}
