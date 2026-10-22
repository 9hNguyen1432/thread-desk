import { basename } from 'node:path';
import { run, type RunError } from '../exec.js';

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** Foreground process group of the process's terminal. */
  tpgid: number;
  rssBytes: number;
  cpuPercent: number;
  startedAt: number | null;
  command: string;
  name: string;
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

const PS_FORMAT = 'pid=,ppid=,pgid=,tpgid=,rss=,%cpu=,etime=,command=';

export function parsePs(stdout: string, now: number): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsed = parseEtime(m[7]!);
    const command = m[8]!.trim();
    out.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      tpgid: Number(m[4]),
      rssBytes: Number(m[5]) * 1024,
      cpuPercent: Number(m[6]),
      startedAt: elapsed === null ? null : now - elapsed,
      command,
      name: basename(command.split(/\s+/)[0] ?? '').replace(/^-/, ''),
    });
  }
  return out;
}

/** Every process on the machine, or only `pids`, in one `ps` call. */
export async function listProcesses(pids?: number[]): Promise<Map<number, ProcInfo>> {
  if (pids && pids.length === 0) return new Map();
  const args = pids ? ['-o', PS_FORMAT, '-p', pids.join(',')] : ['-axo', PS_FORMAT];
  // ps exits non-zero when some of the pids have already exited; what it printed is still valid.
  const stdout = await run('ps', args, { timeoutMs: 8000 })
    .then((r) => r.stdout)
    .catch((e: RunError) => e.stdout);
  return parsePs(stdout, Date.now());
}

/** A process and all of its descendants. */
export function processTree(procs: Map<number, ProcInfo>, root: number): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs.values()) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const out: ProcInfo[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = procs.get(pid);
    if (p) out.push(p);
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return out;
}

export const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu', 'login']);
