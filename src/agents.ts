import { basename } from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'pi' | 'copilot';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'copilot'];

/** What a terminal can tell about a process; any field may be missing. */
export interface ProcessView {
  name?: string | null;
  path?: string | null;
  /** Full command line, when the terminal or `ps` provides it. */
  command?: string | null;
}

export interface AgentDef {
  kind: AgentKind;
  label: string;
  matchesProcess(p: ProcessView): boolean;
}

/** The program a command line runs: the script for `node script.js`, the binary otherwise. */
function programOf(command: string | null | undefined): string | null {
  if (!command) return null;
  const parts = command.trim().split(/\s+/);
  const first = basename(parts[0] ?? '');
  if ((first === 'node' || first === 'bun') && parts[1]) return parts[1];
  return parts[0] ?? null;
}

function runs(p: ProcessView, test: (program: string) => boolean): boolean {
  const program = programOf(p.command);
  if (program && test(program)) return true;
  if (p.path && test(p.path)) return true;
  return Boolean(p.name && test(p.name));
}

export const AGENTS: Record<AgentKind, AgentDef> = {
  claude: {
    kind: 'claude',
    label: 'Claude Code',
    matchesProcess: (p) => runs(p, (s) => /\/claude\/versions\/[^/]+$/.test(s) || basename(s) === 'claude'),
  },
  codex: {
    kind: 'codex',
    label: 'Codex',
    // The npm launcher (`codex` or `codex.js`) starts a native `codex` binary.
    matchesProcess: (p) => runs(p, (s) => /^codex(\.js)?$/.test(basename(s)) || /@openai\/codex\//.test(s)),
  },
  pi: {
    kind: 'pi',
    label: 'Pi',
    matchesProcess: (p) => runs(p, (s) => basename(s) === 'pi' || /pi-coding-agent\/dist\/cli\.js$/.test(s)),
  },
  copilot: {
    kind: 'copilot',
    label: 'Copilot',
    matchesProcess: (p) => runs(p, (s) => basename(s) === 'copilot' || /@github\/copilot\//.test(s)),
  },
};

export function agentOfProcess(p: ProcessView): AgentKind | null {
  for (const kind of AGENT_KINDS) if (AGENTS[kind].matchesProcess(p)) return kind;
  return null;
}

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The session an agent was started on, when its command line names one (`--resume <id>` and the like). */
export function sessionIdInCommand(command: string | null | undefined): string | null {
  return command ? (UUID_IN.exec(command)?.[0]?.toLowerCase() ?? null) : null;
}
