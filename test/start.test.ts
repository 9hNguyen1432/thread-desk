import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { prepareLaunch } from '../src/start.js';

function repo(): { root: string; repoDir: string; dataDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-start-')));
  const repoDir = join(root, 'app');
  mkdirSync(repoDir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'README.md'), 'hi\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  return { root, repoDir, dataDir };
}

const cfg = structuredClone(DEFAULT_CONFIG);

describe('prepareLaunch', () => {
  it('creates a worktree next to the repo and a command that reads the prompt from a file', async () => {
    const { root, repoDir, dataDir } = repo();
    const out = await prepareLaunch(
      { cwd: repoDir, title: "CN-9 It's broken", prompt: 'Fix $(rm -rf /) `x`', worktree: true, branch: 'feat/cn-9-broken', key: 'CN-9' },
      cfg,
      dataDir,
    );
    expect(out.dir).toBe(join(root, 'app-cn-9'));
    expect(existsSync(join(out.dir, 'README.md'))).toBe(true);
    expect(out.command).toMatch(/^'claude' -n 'CN-9 It'\\''s broken' -- "\$\(cat '.+\.txt'\)"$/);
    const promptFile = /cat '(.+)'/.exec(out.command)![1]!;
    expect(readFileSync(promptFile, 'utf8')).toBe('Fix $(rm -rf /) `x`');
  });

  it('refuses an existing worktree path and invalid branch names', async () => {
    const { root, repoDir, dataDir } = repo();
    mkdirSync(join(root, 'app-cn-1'));
    await expect(
      prepareLaunch({ cwd: repoDir, title: 't', prompt: 'p', worktree: true, branch: 'feat/cn-1', key: 'CN-1' }, cfg, dataDir),
    ).rejects.toThrow(/already exists/);
    await expect(
      prepareLaunch({ cwd: repoDir, title: 't', prompt: 'p', worktree: true, branch: 'bad..name', key: 'CN-2' }, cfg, dataDir),
    ).rejects.toThrow(/Invalid branch/);
  });

  it('turns any key into a single safe folder name', async () => {
    const { root, repoDir, dataDir } = repo();
    const out = await prepareLaunch(
      { cwd: repoDir, title: 'Issue', prompt: 'p', worktree: true, branch: 'feat/issue-12', key: '../../acme/app#12' },
      cfg,
      dataDir,
    );
    expect(out.dir).toBe(join(root, 'app-acme-app-12'));
  });

  it('uses the folder as is without a worktree and rejects missing folders', async () => {
    const { repoDir, dataDir } = repo();
    expect((await prepareLaunch({ cwd: repoDir, title: 't', prompt: 'p', worktree: false, branch: '', key: null }, cfg, dataDir)).dir).toBe(repoDir);
    await expect(
      prepareLaunch({ cwd: join(repoDir, 'nope'), title: 't', prompt: 'p', worktree: false, branch: '', key: null }, cfg, dataDir),
    ).rejects.toThrow(/Not a directory/);
  });
});
