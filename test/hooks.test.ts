import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_HEADER, hookEffect, hooksInstalled, installHooks, uninstallHooks, withOurHooks, withoutOurHooks } from '../src/hooks.js';

const ID = '0ba77485-d205-4e3d-bb75-0cd9b24069e6';

describe('hookEffect', () => {
  it('maps events to live states', () => {
    expect(hookEffect({ hook_event_name: 'UserPromptSubmit', session_id: ID }, 1)).toMatchObject({ kind: 'set', state: { status: 'running' } });
    expect(hookEffect({ hook_event_name: 'Stop', session_id: ID, last_assistant_message: ' hi ' }, 1)).toMatchObject({
      kind: 'set',
      state: { status: 'needs_you', lastAssistantMessage: 'hi' },
    });
    expect(hookEffect({ hook_event_name: 'Notification', session_id: ID, notification_type: 'permission_prompt' }, 1)).toMatchObject({
      state: { status: 'needs_you' },
    });
    expect(hookEffect({ hook_event_name: 'Notification', session_id: ID, notification_type: 'auth_success' }, 1)).toEqual({ kind: 'none' });
    expect(hookEffect({ hook_event_name: 'SessionEnd', session_id: ID }, 1)).toEqual({ kind: 'clear', sessionId: ID });
  });

  it('rejects payloads without a valid session id', () => {
    expect(hookEffect({ hook_event_name: 'Stop', session_id: '../etc' }, 1)).toEqual({ kind: 'none' });
    expect(hookEffect({ hook_event_name: 'Stop' }, 1)).toEqual({ kind: 'none' });
  });
});

describe('settings editing', () => {
  const existing = {
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cmux hooks claude stop' }] }] },
  };

  it('adds our handlers next to existing ones and removes only ours', () => {
    const added = withOurHooks(existing, 4545, 'sekret');
    expect(added.model).toBe('opus');
    expect(added.hooks?.Stop).toHaveLength(2);
    expect(added.hooks?.Stop?.[1]?.hooks?.[0]).toMatchObject({ type: 'http', url: 'http://127.0.0.1:4545/hooks', headers: { [SECRET_HEADER]: 'sekret' } });
    expect(Object.keys(added.hooks ?? {})).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']));
    expect(withoutOurHooks(added)).toEqual(existing);
  });

  it('is idempotent', () => {
    const twice = withOurHooks(withOurHooks(existing, 4545, 'a'), 4546, 'b');
    expect(twice.hooks?.Stop).toHaveLength(2);
    expect(twice.hooks?.Stop?.[1]?.hooks?.[0]?.url).toBe('http://127.0.0.1:4546/hooks');
  });

  it('leaves unrelated empty groups and events alone', () => {
    const odd = { hooks: { PreToolUse: [], Stop: [{ matcher: '', hooks: [] }, { hooks: [{ type: 'command', command: 'x' }] }] } };
    const roundTrip = withoutOurHooks(withOurHooks(odd, 1, 's'));
    expect(roundTrip).toEqual(odd);
    expect(withoutOurHooks({ hooks: {} })).toEqual({ hooks: {} });
  });

  it('drops the hooks key when nothing else is left', () => {
    expect(withoutOurHooks(withOurHooks({ model: 'x' }, 1, 's'))).toEqual({ model: 'x' });
  });

  it('backs up the settings file on install and uninstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-hooks-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(existing));
    const { backup } = installHooks(dir, 4545, 's');
    expect(backup).not.toBeNull();
    expect(hooksInstalled(dir)).toBe(true);
    const removed = uninstallHooks(dir);
    expect(removed.changed).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual(existing);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toHaveLength(2);
    expect(uninstallHooks(dir).changed).toBe(false);
  });
});
