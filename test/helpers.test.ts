import { describe, expect, it } from 'vitest';
import { mergeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { parseAgents } from '../src/live/agents.js';
import { parseRecapOutput, buildRecapInput } from '../src/recap.js';
import { adfToText, jiraCategory, linearCategory } from '../src/remote/trackers.js';
import { ftsQuery, makeSnippet, parseQuery } from '../src/search.js';
import { branchName, shQuote, slugify } from '../src/start.js';
import { cmuxStatus, inspectWorkspace, parseTop } from '../src/terminal/cmux.js';

describe('search helpers', () => {
  it('quotes every token so FTS syntax cannot break', () => {
    expect(ftsQuery('billing "re" OR NEAR(')).toBe('"billing"* "re"* "OR"* "NEAR"*');
    expect(ftsQuery('đoán')).toBe('"doán"*');
    expect(ftsQuery('  ')).toBeNull();
  });

  it('extracts project and is filters', () => {
    expect(parseQuery('project:api is:done login bug')).toEqual({ text: 'login bug', project: 'api', is: 'done' });
  });

  it('builds a snippet around the first match, ignoring accents', () => {
    const text = 'x'.repeat(300) + ' Phán đoán của nhóm ' + 'y'.repeat(300);
    const snippet = makeSnippet(text, 'phan doan');
    expect(snippet).toContain('Phán đoán');
    expect(snippet.startsWith('…')).toBe(true);
  });
});

describe('cmux parsing', () => {
  it('maps sidebar values to statuses', () => {
    expect(cmuxStatus('Needs input')).toBe('needs_you');
    expect(cmuxStatus('Running')).toBe('running');
    expect(cmuxStatus('Idle')).toBe('idle');
    expect(cmuxStatus('Something else')).toBeNull();
  });

  it('reads tabs, memory, Claude pid and cwd from top output', () => {
    const top = {
      windows: [
        {
          ref: 'window:1',
          workspaces: [
            {
              ref: 'workspace:31',
              title: '✳ Job offer',
              resources: { memory_bytes: 1310755936, cpu_percent: 2 },
              tags: [{ key: 'claude_code', value: 'Needs input', pid: 2157 }],
              panes: [{ surfaces: [{ type: 'terminal', foreground_pgids: [2157], processes: [{ pid: 2157, name: '2.1.299', path: '/u/.local/share/claude/versions/2.1.299' }] }] }],
            },
            { ref: 'workspace:2', title: 'zsh', resources: {}, tags: [] },
          ],
        },
      ],
    };
    const tabs = parseTop(top, new Map([['workspace:31', '/w/api']]));
    expect(tabs[0]).toEqual({
      ref: 'workspace:31',
      windowRef: 'window:1',
      title: '✳ Job offer',
      cwd: '/w/api',
      memoryBytes: 1310755936,
      cpuPercent: 2,
      agentPid: 2157,
      agentKind: 'claude',
      agentStartedAt: null,
      agentSessionHint: null,
      agentStatus: 'needs_you',
      closeBlock: null,
    });
    expect(tabs[1]).toMatchObject({ agentPid: null, agentStatus: null, memoryBytes: 0, closeBlock: expect.stringMatching(/0 panes/) });
  });

  it('finds Claude in the foreground when the sidebar tag is missing', () => {
    const ws = {
      panes: [{ surfaces: [{ type: 'terminal', foreground_pgids: [8715], processes: [{ pid: 700, name: '-zsh', children: [{ pid: 8715, name: '2.1.294', path: '/u/.local/share/claude/versions/2.1.294' }] }] }] }],
    };
    expect(inspectWorkspace(ws)).toEqual({ agentPid: 8715, agentKind: 'claude', agentStartedAt: null, agentSessionHint: null, closeBlock: null });
  });

  it('recognizes node-based agents from their command line and reads a resumed session id', () => {
    const ws = {
      panes: [{ surfaces: [{ type: 'terminal', foreground_pgids: [900], processes: [{ pid: 1, name: 'zsh', children: [{ pid: 900, name: 'node', path: '/usr/local/bin/node' }] }] }] }],
    };
    const ps = (command: string) =>
      new Map([[900, { pid: 900, ppid: 1, pgid: 900, tpgid: 900, rssBytes: 0, cpuPercent: 0, startedAt: 1000, command, name: 'node' }]]);
    // Without a command line, a bare `node` is just another program.
    expect(inspectWorkspace(ws).closeBlock).toBe('node is running in this tab');
    expect(inspectWorkspace(ws, ps('node /u/.nvm/bin/codex resume 0199a213-81c0-7800-8aa1-bbab2a035a53'))).toEqual({
      agentPid: 900,
      agentKind: 'codex',
      agentStartedAt: 1000,
      agentSessionHint: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      closeBlock: null,
    });
    expect(inspectWorkspace(ws, ps('node /u/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js')).agentKind).toBe('pi');
    expect(inspectWorkspace(ws, ps('node /u/bin/copilot --resume=abc')).agentKind).toBe('copilot');
    expect(inspectWorkspace(ws, ps('node server.js')).closeBlock).toBe('node is running in this tab');
  });

  it('blocks closing splits, browsers and other foreground programs', () => {
    const term = (fg: number, name: string) => ({ type: 'terminal', foreground_pgids: [fg], processes: [{ pid: 1, name: 'zsh', children: [{ pid: fg, name }] }] });
    expect(inspectWorkspace({ panes: [{ surfaces: [term(5, 'npm')] }] }).closeBlock).toBe('npm is running in this tab');
    expect(inspectWorkspace({ panes: [{ surfaces: [term(5, 'claude')] }, { surfaces: [term(6, 'zsh')] }] }).closeBlock).toMatch(/2 panes/);
    expect(inspectWorkspace({ panes: [{ surfaces: [{ type: 'browser' }] }] }).closeBlock).toMatch(/not a terminal/);
    expect(inspectWorkspace({ panes: [{ surfaces: [{ type: 'terminal', foreground_pgids: [1], processes: [{ pid: 1, name: '-zsh' }] }] }] }).closeBlock).toBeNull();
  });
});

describe('parseAgents', () => {
  it('keeps entries with a session id and normalizes fields', () => {
    const out = parseAgents([
      { pid: 8539, cwd: '/w', kind: 'interactive', startedAt: 1, sessionId: 'a', name: 'n', status: 'idle' },
      { id: 'x', kind: 'background', sessionId: 'b', state: 'blocked' },
      { kind: 'interactive' },
      null,
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ sessionId: 'b', pid: null, state: 'blocked', status: null });
    expect(parseAgents('nope')).toEqual([]);
  });
});

describe('recap', () => {
  it('parses the JSON object out of the print-mode envelope', () => {
    const stdout = JSON.stringify({ result: 'Here:\n{"goal":"g","done":"d","next":"n","blocker":""}' });
    expect(parseRecapOutput(stdout)).toEqual({ goal: 'g', done: 'd', next: 'n', blocker: '' });
    expect(() => parseRecapOutput(JSON.stringify({ is_error: true }))).toThrow();
  });

  it('labels speakers in the input', () => {
    expect(buildRecapInput('start', [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }])).toContain('USER: a\n\nASSISTANT: b');
  });
});

describe('trackers', () => {
  it('maps status categories', () => {
    expect(jiraCategory('done')).toBe('done');
    expect(jiraCategory('indeterminate')).toBe('in_progress');
    expect(jiraCategory(undefined)).toBe('todo');
    expect(linearCategory('canceled')).toBe('done');
    expect(linearCategory('started')).toBe('in_progress');
  });

  it('flattens Atlassian documents to text', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'World' }] }] };
    expect(adfToText(doc)).toBe('Hello\nWorld\n');
  });
});

describe('start helpers', () => {
  it('slugifies Vietnamese and symbols', () => {
    expect(slugify('Đặt lịch phỏng vấn: Workday!')).toBe('dat-lich-phong-van-workday');
  });

  it('fills branch templates with or without a key', () => {
    expect(branchName('feat/{key}-{slug}', 'CN-12', 'Fix login')).toBe('feat/cn-12-fix-login');
    expect(branchName('feat/{key}-{slug}', null, 'Fix login')).toBe('feat/fix-login');
  });

  it('quotes for POSIX shells', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('mergeConfig', () => {
  it('keeps defaults for missing or mistyped values and ignores unknown keys', () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { port: 'x', onDone: 'close', cleanup: { idleHours: 6 }, extra: 1 });
    expect(merged.port).toBe(4545);
    expect(merged.onDone).toBe('close');
    expect(merged.cleanup).toEqual({ ...DEFAULT_CONFIG.cleanup, idleHours: 6 });
    expect('extra' in merged).toBe(false);
  });
});

describe('RecapQueue accounting', () => {
  it('counts only calls that happened, persists the count, and never runs the same thread twice at once', async () => {
    const { RecapQueue } = await import('../src/recap.js');
    const counts = new Map<string, number>();
    const counter = { used: (d: string) => counts.get(d) ?? 0, add: (d: string) => counts.set(d, (counts.get(d) ?? 0) + 1) };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const q = new RecapQueue(
      async (id) => {
        calls.push(id);
        if (id === 'skip') return false;
        await gate;
        return true;
      },
      () => 2,
      counter,
    );
    q.push('a');
    expect(q.push('a')).toBe(false);
    q.push('skip');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a', 'skip']);
    expect([...counts.values()]).toEqual([1]);
    expect(q.remainingToday).toBe(1);
  });
});

describe('run', () => {
  it('survives a child that exits without reading its input', async () => {
    const { run } = await import('../src/exec.js');
    const big = 'x'.repeat(4 * 1024 * 1024);
    await expect(run('sh', ['-c', 'exit 0'], { input: big })).resolves.toBeDefined();
    await expect(run('sh', ['-c', 'exit 3'], { input: big })).rejects.toThrow();
  });
});
