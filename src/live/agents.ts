import { runJson } from '../exec.js';

export interface AgentInfo {
  sessionId: string;
  pid: number | null;
  kind: string;
  status: string | null;
  state: string | null;
  waitingFor: string | null;
  name: string | null;
  cwd: string | null;
  startedAt: number | null;
}

type RawAgent = Record<string, unknown>;

function s(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseAgents(raw: unknown): AgentInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentInfo[] = [];
  for (const item of raw as RawAgent[]) {
    if (!item || typeof item !== 'object') continue;
    const sessionId = s(item.sessionId);
    if (!sessionId) continue;
    out.push({
      sessionId,
      pid: n(item.pid),
      kind: s(item.kind) ?? 'interactive',
      status: s(item.status),
      state: s(item.state),
      waitingFor: s(item.waitingFor),
      name: s(item.name),
      cwd: s(item.cwd),
      startedAt: n(item.startedAt),
    });
  }
  return out;
}

export async function fetchAgents(claudeBin: string): Promise<AgentInfo[]> {
  return parseAgents(await runJson<unknown>(claudeBin, ['agents', '--json'], { timeoutMs: 10_000 }));
}
