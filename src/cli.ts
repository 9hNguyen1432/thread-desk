#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import open from 'open';
import { ThreadDesk } from './app.js';
import { TERMINAL_CHOICES, dataDir as resolveDataDir, ensureDataDir, loadConfig, readOrCreateSecret, type Config, type TerminalChoice } from './config.js';
import { openDb } from './db.js';
import { DemoAdapter, createDemoClaudeDir, seedDemoTodos } from './demo.js';
import { hooksInstalled, installHooks, uninstallHooks } from './hooks.js';
import { createServer } from './server.js';
import { CmuxAdapter } from './terminal/cmux.js';
import { KittyAdapter, defaultKittenBin } from './terminal/kitty.js';
import { NoneAdapter } from './terminal/none.js';
import { TmuxAdapter } from './terminal/tmux.js';
import type { TerminalAdapter } from './terminal/types.js';
import type { AgentSource } from './live/state.js';

const HELP = `thread-desk: a local Kanban board for your AI coding sessions (Claude Code, Codex, Pi, Copilot)

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
  --terminal <name>   auto | cmux | tmux | kitty | none
  --demo              run against generated sample sessions
  -h, --help
`;

/**
 * An explicit choice wins. Otherwise the terminal Thread Desk was started in, then whichever of
 * cmux, tmux and kitty answers.
 */
async function pickTerminal(config: Config): Promise<TerminalAdapter> {
  const kitten = defaultKittenBin(config.kittyBin);
  const make: Record<Exclude<TerminalChoice, 'auto'>, () => TerminalAdapter> = {
    cmux: () => new CmuxAdapter(config.cmuxBin),
    tmux: () => new TmuxAdapter(config.tmuxBin),
    kitty: () => new KittyAdapter(kitten),
    none: () => new NoneAdapter(),
  };
  if (config.terminal !== 'auto') return make[config.terminal]();
  if (process.env.TMUX) return make.tmux();
  if (process.env.KITTY_WINDOW_ID) return make.kitty();
  if (process.env.CMUX_WORKSPACE_ID || (await CmuxAdapter.detect(config.cmuxBin))) return make.cmux();
  if (await TmuxAdapter.detect(config.tmuxBin)) return make.tmux();
  if (await KittyAdapter.detect(kitten)) return make.kitty();
  return make.none();
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
  if (values.terminal !== undefined) {
    if (!(TERMINAL_CHOICES as readonly string[]).includes(values.terminal)) throw new Error(`Unknown terminal: ${values.terminal}`);
    config.terminal = values.terminal as TerminalChoice;
  }
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
    // Sample data only: never read the real sessions of other agents.
    for (const agent of Object.values(config.agents)) agent.enabled = false;
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
