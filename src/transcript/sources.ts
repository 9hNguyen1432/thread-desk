import { basename, join } from 'node:path';
import type { AgentKind } from '../agents.js';
import { agentHome, type Config } from '../config.js';
import { parseCodexLine } from './codex.js';
import { copilotSource, type PolledSource } from './copilot.js';
import { parseLine, type ParsedLine } from './parse.js';
import { parsePiLine } from './pi.js';

/** A directory of append-only JSONL transcripts, one file per session. */
export interface JsonlSource {
  agent: AgentKind;
  root: string;
  /** Directory levels between `root` and the session files. */
  depth: number;
  /** The session id a file holds, or null when the file is not a session transcript. */
  sessionId(path: string): string | null;
  parseLine(line: string): ParsedLine | null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_FILE = new RegExp(`^(${UUID})\\.jsonl$`, 'i');
/** `rollout-<timestamp>-<uuid>.jsonl`, or `.jsonl.zst` once Codex compresses a cold session. */
const CODEX_FILE = new RegExp(`^rollout-.+-(${UUID})\\.jsonl(\\.zst)?$`, 'i');
/** `<timestamp>_<uuid>.jsonl` */
const PI_FILE = new RegExp(`^.+_(${UUID})\\.jsonl$`, 'i');

function idFrom(re: RegExp) {
  return (path: string) => re.exec(basename(path))?.[1]?.toLowerCase() ?? null;
}

export function claudeSource(claudeDir: string): JsonlSource {
  return { agent: 'claude', root: join(claudeDir, 'projects'), depth: 1, sessionId: idFrom(CLAUDE_FILE), parseLine };
}

export function codexSource(home: string): JsonlSource {
  return { agent: 'codex', root: join(home, 'sessions'), depth: 3, sessionId: idFrom(CODEX_FILE), parseLine: parseCodexLine };
}

export function piSource(home: string): JsonlSource {
  return { agent: 'pi', root: join(home, 'sessions'), depth: 1, sessionId: idFrom(PI_FILE), parseLine: parsePiLine };
}

export function jsonlSources(config: Config): JsonlSource[] {
  const sources = [claudeSource(config.claudeDir)];
  if (config.agents.codex.enabled) sources.push(codexSource(agentHome(config, 'codex')));
  if (config.agents.pi.enabled) sources.push(piSource(agentHome(config, 'pi')));
  return sources;
}

export function polledSources(config: Config): PolledSource[] {
  return config.agents.copilot.enabled ? [copilotSource(agentHome(config, 'copilot'))] : [];
}
