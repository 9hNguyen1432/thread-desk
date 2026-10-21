#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import open from 'open';
import { ThreadDesk } from './app.js';
import { dataDir as resolveDataDir, ensureDataDir, loadConfig, readOrCreateSecret, type Config } from './config.js';
import { openDb } from './db.js';
import { DemoAdapter, createDemoClaudeDir, seedDemoTodos } from './demo.js';
import { hooksInstalled, installHooks, uninstallHooks } from './hooks.js';
import { createServer } from './server.js';
import { CmuxAdapter } from './terminal/cmux.js';
import { NoneAdapter } from './terminal/none.js';
import type { TerminalAdapter } from './terminal/types.js';
import type { AgentSource } from './live/state.js';

const HELP = `thread-desk: a local Kanban board for your Claude Code sessions

Usage:
  thread-desk [options]            start the board (default)
  thread-desk url                  print the board URL (with its access key)
  thread-desk hooks install        add live-update hooks to ~/.claude/settings.json (backup first)
  thread-desk hooks uninstall      remove them again
  thread-desk hooks status

Options:
  --port <n>          port to listen on (default 4545)
  --no-open           do not open the browser
  --data-dir <path>   where the index and settings live (default ~/.thread-desk)
  --claude-dir <path> Claude Code home (default ~/.claude)
  --terminal <name>   auto | cmux | none
  --demo              run against generated sample sessions
  -h, --help
`;

async function pickTerminal(config: Config): Promise<TerminalAdapter> {
  if (config.terminal === 'none') return new NoneAdapter();
  if (config.terminal === 'cmux' || (await CmuxAdapter.detect(config.cmuxBin))) return new CmuxAdapter(config.cmuxBin);
  return new NoneAdapter();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      'data-dir': { type: 'string' },
      'claude-dir': { type: 'string' },
      terminal: { type: 'string' },
      demo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const baseDir = resolveDataDir(values['data-dir']);
  const dir = values.demo ? join(baseDir, 'demo') : baseDir;
  ensureDataDir(dir);
  const config = loadConfig(dir);
  if (values.port) config.port = Number(values.port);
  if (values['claude-dir']) config.claudeDir = values['claude-dir'];
  if (values.terminal === 'auto' || values.terminal === 'cmux' || values.terminal === 'none') config.terminal = values.terminal;
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) throw new Error(`Invalid port: ${values.port}`);

  const token = readOrCreateSecret(dir, 'token');
  const hookSecret = readOrCreateSecret(dir, 'hook-secret');
  const url = `http://127.0.0.1:${config.port}/#t=${token}`;
  const [command, sub] = positionals;

  if (command === 'url') {
    process.stdout.write(url + '\n');
    return;
  }
  if (command === 'hooks') {
    if (sub === 'install') {
      const { file, backup } = installHooks(config.claudeDir, config.port, hookSecret);
      process.stdout.write(`Installed Thread Desk hooks in ${file}${backup ? `\nBackup: ${backup}` : ''}\n`);
    } else if (sub === 'uninstall') {
      const { file, backup, changed } = uninstallHooks(config.claudeDir);
      process.stdout.write(changed ? `Removed Thread Desk hooks from ${file}\nBackup: ${backup}\n` : 'No Thread Desk hooks found.\n');
    } else {
      process.stdout.write(hooksInstalled(config.claudeDir) ? 'Hooks: installed\n' : 'Hooks: not installed\n');
    }
    return;
  }
  if (command) throw new Error(`Unknown command: ${command}\n\n${HELP}`);

  let terminal: TerminalAdapter;
  let agentSource: AgentSource | undefined;
  if (values.demo) {
    const demo = createDemoClaudeDir(dir);
    config.claudeDir = demo.claudeDir;
    if (config.links.ticketKeys.length === 0) config.links.ticketKeys = ['DEMO'];
    const demoTerminal = new DemoAdapter(demo.tabs);
    terminal = demoTerminal;
    agentSource = () => demoTerminal.agents();
  } else {
    terminal = await pickTerminal(config);
  }

  const db = openDb(dir);
  const app = new ThreadDesk(db, config, dir, terminal, agentSource);
  const server = createServer(app, { port: config.port, token, hookSecret });

  const httpServer = serve({ fetch: server.fetch, port: config.port, hostname: '127.0.0.1' }, () => {
    process.stdout.write(`Thread Desk running at ${url}\nTerminal: ${terminal.name} · data: ${dir}\n`);
    if (!values['no-open']) void open(url).catch(() => undefined);
  });

  const shutdown = async () => {
    httpServer.close();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.start();
  if (values.demo) seedDemoTodos(app);
}

main().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
