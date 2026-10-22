import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentKind } from '../agents.js';
import { MAX_ASSISTANT_CHARS, MAX_HUMAN_CHARS, truncate, type ParsedLine } from './parse.js';

/** A session store that is a database rather than files: sessions are listed and read by position. */
export interface PolledSource {
  agent: AgentKind;
  /** Files whose changes mean there may be new data. */
  watchFiles: string[];
  /** Every session with a marker that changes whenever the session does; empty when the store is missing. */
  list(): { id: string; stamp: number }[];
  /** Lines describing the session after position `from`, and the position to continue from next time. */
  read(id: string, from: number): { lines: ParsedLine[]; next: number };
  close(): void;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
}

interface TurnRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

/** SQLite `datetime('now')` is UTC without a zone marker; ISO strings with a zone are kept as they are. */
export function sqliteTime(value: string | null): number | undefined {
  if (!value) return undefined;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** GitHub Copilot CLI keeps sessions and turns in `session-store.db` (opened read-only here). */
export function copilotSource(home: string): PolledSource {
  const file = join(home, 'session-store.db');
  let db: Database.Database | null = null;
  const open = (): Database.Database | null => {
    if (db) return db;
    if (!existsSync(file)) return null;
    db = new Database(file, { readonly: true, fileMustExist: true });
    return db;
  };

  return {
    agent: 'copilot',
    watchFiles: [file, `${file}-wal`],
    list() {
      const conn = open();
      if (!conn) return [];
      const rows = conn
        .prepare(
          `select s.id, s.updated_at, (select count(*) from turns t where t.session_id = s.id) as turns from sessions s`,
        )
        .all() as { id: string; updated_at: string | null; turns: number }[];
      return rows.map((r) => ({ id: r.id, stamp: (sqliteTime(r.updated_at) ?? 0) + r.turns }));
    },
    read(id, from) {
      const conn = open();
      if (!conn) return { lines: [], next: from };
      const session = conn.prepare('select id, cwd, branch, summary, created_at from sessions where id = ?').get(id) as
        | SessionRow
        | undefined;
      if (!session) return { lines: [], next: from };
      const lines: ParsedLine[] = [
        {
          ts: sqliteTime(session.created_at),
          cwd: session.cwd ?? undefined,
          gitBranch: session.branch ?? undefined,
          aiTitle: session.summary?.trim() || undefined,
        },
      ];
      const turns = conn
        .prepare(
          'select turn_index, user_message, assistant_response, timestamp from turns where session_id = ? and turn_index >= ? order by turn_index',
        )
        .all(id, from) as TurnRow[];
      let next = from;
      for (const [i, t] of turns.entries()) {
        const ts = sqliteTime(t.timestamp);
        const human = t.user_message?.trim();
        const assistant = t.assistant_response?.trim();
        // The newest turn may still be waiting for its answer; read it again once it has one.
        if (i === turns.length - 1 && human && !assistant) break;
        if (human) lines.push({ ts, human: truncate(human, MAX_HUMAN_CHARS) });
        if (assistant) lines.push({ ts, assistant: truncate(assistant, MAX_ASSISTANT_CHARS) });
        next = t.turn_index + 1;
      }
      return { lines, next };
    },
    close() {
      db?.close();
      db = null;
    },
  };
}
