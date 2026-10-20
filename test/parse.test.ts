import { describe, expect, it } from 'vitest';
import { cleanHumanText, displayTitle, parseLine } from '../src/transcript/parse.js';

const base = { cwd: '/w/app', gitBranch: 'feat/x', version: '2.1.304', sessionId: 's', timestamp: '2026-10-20T07:00:00.000Z' };

describe('parseLine', () => {
  it('ignores malformed and non-object lines', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(parseLine('[1,2]')).toBeNull();
    expect(parseLine('"x"')).toBeNull();
  });

  it('reads titles, pr links and continuations', () => {
    expect(parseLine(JSON.stringify({ type: 'custom-title', customTitle: 'Fix login' }))?.customTitle).toBe('Fix login');
    expect(parseLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Login bug' }))?.aiTitle).toBe('Login bug');
    expect(parseLine(JSON.stringify({ type: 'agent-name', agentName: 'api' }))?.agentName).toBe('api');
    expect(parseLine(JSON.stringify({ type: 'continued-in', continuedInSessionId: 'next' }))?.continuedIn).toBe('next');
    const pr = parseLine(JSON.stringify({ type: 'pr-link', prNumber: 7, prUrl: 'https://github.com/a/b/pull/7', prRepository: 'a/b' }));
    expect(pr?.pr).toEqual({ number: 7, url: 'https://github.com/a/b/pull/7', repo: 'a/b' });
  });

  it('extracts a human prompt with metadata', () => {
    const p = parseLine(JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'fix CN-12 please' } }));
    expect(p).toMatchObject({ human: 'fix CN-12 please', cwd: '/w/app', gitBranch: 'feat/x', version: '2.1.304' });
    expect(p?.ts).toBe(Date.parse(base.timestamp));
  });

  it('skips tool results, meta, compact summaries, sidechains and non-human origins', () => {
    const toolResult = { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } };
    expect(parseLine(JSON.stringify(toolResult))?.human).toBeUndefined();
    expect(parseLine(JSON.stringify({ ...base, type: 'user', isMeta: true, message: { content: 'meta' } }))?.human).toBeUndefined();
    expect(parseLine(JSON.stringify({ ...base, type: 'user', isCompactSummary: true, message: { content: 'sum' } }))?.human).toBeUndefined();
    expect(parseLine(JSON.stringify({ ...base, type: 'user', isSidechain: true, message: { content: 'sub' } }))).toBeNull();
    const notification = { ...base, type: 'user', origin: { kind: 'task-notification' }, message: { content: 'done' } };
    expect(parseLine(JSON.stringify(notification))?.human).toBeUndefined();
  });

  it('joins assistant text blocks and ignores thinking and tool use', () => {
    const line = {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'First' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'text', text: 'Second' },
        ],
      },
    };
    expect(parseLine(JSON.stringify(line))?.assistant).toBe('First\nSecond');
  });

  it('keeps timestamps of unknown line types but nothing else', () => {
    expect(parseLine(JSON.stringify({ type: 'brand-new', timestamp: base.timestamp }))).toEqual({ ts: Date.parse(base.timestamp) });
    expect(parseLine(JSON.stringify({ type: 'brand-new' }))).toBeNull();
  });
});

describe('cleanHumanText', () => {
  it('drops injected messages', () => {
    expect(cleanHumanText('<task-notification>x</task-notification>')).toBeUndefined();
    expect(cleanHumanText('Another Claude session sent a message:\nhi')).toBeUndefined();
    expect(cleanHumanText('[Request interrupted by user]')).toBeUndefined();
    expect(cleanHumanText('<local-command-stdout>ok</local-command-stdout>')).toBeUndefined();
  });

  it('turns slash commands into a short form', () => {
    const raw = '<command-name>/goal</command-name>\n  <command-message>goal</command-message>\n  <command-args>ship it</command-args>';
    expect(cleanHumanText(raw)).toBe('/goal ship it');
    expect(cleanHumanText('<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>')).toBe('/compact');
  });

  it('strips system reminders and pasted-content tags', () => {
    expect(cleanHumanText('hello <system-reminder>secret</system-reminder>world')).toBe('hello world');
    expect(cleanHumanText('<pasted_content id="1">log line</pasted_content> see this')).toBe('log line see this');
    expect(cleanHumanText('<system-reminder>only</system-reminder>')).toBeUndefined();
  });
});

describe('displayTitle', () => {
  it('prefers custom title, then agent name, then AI title, then first prompt', () => {
    expect(displayTitle({ custom_title: 'A', agent_name: 'B', ai_title: 'C', first_prompt: 'D' })).toBe('A');
    expect(displayTitle({ agent_name: 'B', ai_title: 'C', first_prompt: 'D' })).toBe('B');
    expect(displayTitle({ ai_title: 'C', first_prompt: 'D' })).toBe('C');
    expect(displayTitle({ first_prompt: 'D\n\nmore' })).toBe('D more');
    expect(displayTitle({})).toBe('Untitled session');
  });
});
