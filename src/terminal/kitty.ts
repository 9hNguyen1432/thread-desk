import { existsSync } from 'node:fs';
import { agentOfProcess, sessionIdInCommand } from '../agents.js';
import { run, runJson, type RunError } from '../exec.js';
import { listProcesses, processTree, SHELLS, type ProcInfo } from './processes.js';
import type { OpenOptions, Tab, TerminalAdapter } from './types.js';

interface KittyProcess {
  pid?: number;
  cwd?: string;
  cmdline?: string[];
}

interface KittyWindow {
  id?: number;
  pid?: number;
  cwd?: string;
  foreground_processes?: KittyProcess[];
  is_self?: boolean;
}

interface KittyTab {
  id?: number;
  title?: string;
  windows?: KittyWindow[];
}

export interface KittyOsWindow {
  id?: number;
  tabs?: KittyTab[];
}

const basename = (path: string) => path.split('/').pop() ?? path;

/**
 * A kitty tab is one tab. It is only safe to close when it holds a single window whose foreground
 * processes are a coding agent or an idle shell, and it is not the window Thread Desk itself runs in.
 */
export function kittyTabs(osWindows: KittyOsWindow[], procs: Map<number, ProcInfo>): Tab[] {
  const tabs: Tab[] = [];
  for (const os of osWindows) {
    for (const tab of os.tabs ?? []) {
      if (tab.id === undefined) continue;
      const windows = tab.windows ?? [];
      const win = windows[0];
      // kitty lists every process in the foreground group, including an agent's own children (MCP
      // servers and the like); only the group leaders say what is actually running in the tab.
      const all = win?.foreground_processes ?? [];
      const leaders = all.filter((p) => p.pid !== undefined && procs.get(p.pid)?.pgid === p.pid);
      const fg = (leaders.length ? leaders : all).map((p) => {
        const command = (p.cmdline ?? []).join(' ');
        return { p, command, name: basename(p.cmdline?.[0] ?? '').replace(/^-/, ''), kind: agentOfProcess({ command }) };
      });
      const agent = fg.find((f) => f.kind !== null);
      const tree = win?.pid ? processTree(procs, win.pid) : [];
      let closeBlock: string | null = null;
      if (windows.length !== 1) closeBlock = `This tab has ${windows.length} windows; close it in kitty instead`;
      else if (win!.is_self) closeBlock = 'Thread Desk is running in this tab';
      else if (fg.length === 0) closeBlock = 'Cannot tell what is running in this tab';
      else {
        const other = fg.find((f) => f.kind === null && !SHELLS.has(f.name));
        if (other) closeBlock = `${other.name || 'Another program'} is running in this tab`;
      }
      const agentPid = agent?.p.pid ?? null;
      tabs.push({
        ref: String(tab.id),
        windowRef: String(os.id ?? ''),
        title: tab.title ?? '',
        cwd: agent?.p.cwd ?? win?.cwd ?? null,
        memoryBytes: tree.reduce((sum, p) => sum + p.rssBytes, 0),
        cpuPercent: tree.reduce((sum, p) => sum + p.cpuPercent, 0),
        agentPid,
        agentKind: agent?.kind ?? null,
        agentStartedAt: agentPid !== null ? (procs.get(agentPid)?.startedAt ?? null) : null,
        agentSessionHint: agent ? sessionIdInCommand(agent.command) : null,
        agentStatus: null,
        closeBlock,
      });
    }
  }
  return tabs;
}

/** `kitten` is not always on PATH when kitty was installed as a macOS app. */
export function defaultKittenBin(configured: string): string {
  if (configured !== 'kitten') return configured;
  const bundled = '/Applications/kitty.app/Contents/MacOS/kitten';
  return process.env.KITTY_INSTALLATION_DIR ? `${process.env.KITTY_INSTALLATION_DIR}/MacOS/kitten` : existsSync(bundled) ? bundled : configured;
}

export class KittyAdapter implements TerminalAdapter {
  readonly name = 'kitty' as const;

  constructor(private readonly bin: string) {}

  /** Remote control must be on (`allow_remote_control`), and `listen_on` when started outside kitty. */
  private remote(args: string[]): string[] {
    const to = process.env.KITTY_LISTEN_ON;
    return ['@', ...(to ? ['--to', to] : []), ...args];
  }

  static async detect(bin: string): Promise<boolean> {
    try {
      await new KittyAdapter(bin).listTabs();
      return true;
    } catch {
      return false;
    }
  }

  async listTabs(): Promise<Tab[]> {
    const os = await runJson<KittyOsWindow[]>(this.bin, this.remote(['ls']), { timeoutMs: 5000 }).catch((e: RunError) => {
      if (e.code === 'ENOENT') throw e;
      throw new Error('kitty refused remote control. Add `allow_remote_control yes` (and `listen_on unix:/tmp/kitty` to start Thread Desk outside kitty) to kitty.conf, then restart kitty.');
    });
    return kittyTabs(os, await listProcesses());
  }

  async sessionIdForTab(): Promise<string | null> {
    return null;
  }

  async focus(tab: Tab): Promise<void> {
    await run(this.bin, this.remote(['focus-tab', '--match', `id:${tab.ref}`]));
  }

  async close(tab: Tab): Promise<void> {
    await run(this.bin, this.remote(['close-tab', '--match', `id:${tab.ref}`]));
  }

  /** Opens a shell tab and types the command, so the tab stays open after the agent exits. */
  async open(opts: OpenOptions): Promise<void> {
    const { stdout } = await run(this.bin, this.remote(['launch', '--type=tab', '--cwd', opts.cwd, '--tab-title', opts.title.slice(0, 60)]));
    const windowId = stdout.trim();
    // Text given as an argument is decoded with Python escape rules; from stdin it is sent as is.
    await run(this.bin, this.remote(['send-text', '--match', `id:${windowId}`, '--stdin']), { input: `${opts.command}\r` });
  }

  /** kitty has no per-tab status field to borrow, and renaming tabs would overwrite the user's titles. */
  async setBadge(): Promise<void> {}
}
