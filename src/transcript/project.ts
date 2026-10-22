import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { run } from '../exec.js';

const cache = new Map<string, string>();

/**
 * Groups worktrees under their main repository: the project of a cwd is the parent of
 * its git common dir, or the cwd itself when it is not inside a git repo.
 */
export async function resolveProject(cwd: string): Promise<string> {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let project = cwd;
  if (existsSync(cwd)) {
    try {
      const { stdout } = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 5000 });
      const common = stdout.trim();
      if (common) {
        const abs = isAbsolute(common) ? common : resolve(cwd, common);
        project = dirname(abs);
      }
    } catch {
      project = cwd;
    }
  }
  cache.set(cwd, project);
  return project;
}

/** The branch currently checked out in `cwd`, or null outside a git repo or on a detached HEAD. */
export async function resolveBranch(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}
