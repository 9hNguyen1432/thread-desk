# Contributing

Thanks for helping. Bug reports with a short description of your setup (OS, Node, Claude Code and
terminal versions) are the most useful thing you can send.

## Ground rules

- Never commit real transcripts. Tests use small synthetic JSONL written inside the test itself.
  `npm run check:secrets` fails if anything that looks like an email address, token or private key shows
  up in tracked files.
- Keep the server free of a shell: use `run()` from `src/exec.ts` with an argument array.
- The transcript format is internal to Claude Code. Parse defensively, ignore unknown fields, and add a
  test case for every new line shape you handle.

## Layout

```text
src/
  cli.ts              entry point and commands
  app.ts              wires indexer, live state, integrations and actions
  server.ts           HTTP routes, access key, host/origin checks, SSE
  transcript/         JSONL parser and incremental indexer
  live/               claude agents polling and live snapshot
  terminal/           terminal adapters (cmux, none)
  remote/             GitHub, Jira, Linear, Slack
  board.ts            status and column rules
  cleanup.ts          which tabs are safe to close
web/src/              React board
test/                 vitest
```

## Adding a terminal adapter

Implement `TerminalAdapter` from `src/terminal/types.ts`:

- `listTabs()` returns open tabs with memory, the Claude process id (if any) and a status hint.
- `sessionIdForTab()` maps a tab to a Claude session when the process id cannot be matched with
  `claude agents --json`.
- `focus`, `close`, `open` and `setBadge` perform actions; throw a clear error if the terminal cannot.

Then pick it in `pickTerminal()` in `src/cli.ts`. tmux, WezTerm, Kitty and iTerm adapters are welcome.

## Adding a tracker

Add a fetcher to `src/remote/trackers.ts` that returns `{ state, category, title, url }` and route keys
to it in `RemoteStatus.trackerFor()`. Read credentials from environment variables only.

## Before opening a pull request

```sh
npm run typecheck
npm test
npm run check:secrets
npm run build
```
