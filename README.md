# Thread Desk

[![npm](https://img.shields.io/npm/v/thread-desk)](https://www.npmjs.com/package/thread-desk) [![CI](https://github.com/9hNguyen1432/thread-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/9hNguyen1432/thread-desk/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/thread-desk)](https://github.com/9hNguyen1432/thread-desk/blob/main/LICENSE)

**A mission-control board for AI coding agents running in [cmux](https://cmux.com).**
Today it supports Claude Code; Codex and other agents are next.

If you run many AI coding sessions side by side, each in its own cmux tab, you know the feeling: thirty
tabs, and you no longer remember which one is waiting for you, which one was about that ticket, which
ones are finished, and which you can close to get your memory back. Thread Desk reads the transcripts the
agent already keeps on your machine, asks cmux which tabs are alive and how much memory they use, and
puts every thread on one Kanban board you can search, clean up and resume from.

![Thread Desk running inside cmux: a new thread shows up as Running, open threads become today's todos, ⌘K jumps to a ticket's tab, and marking a thread done closes its tab](https://raw.githubusercontent.com/9hNguyen1432/thread-desk/main/docs/demo.gif)

Everything runs on your machine at `http://127.0.0.1:4545`. Nothing is uploaded.

## What it supports today

| | Supported now | Notes |
| --- | --- | --- |
| **Agent** | Claude Code 2.x | Reads `~/.claude/projects`, live status from `claude agents --json` |
| **Terminal** | cmux on macOS (full) | Tab status, memory per tab, jump, close, resume in a new tab, sidebar badges |
| | Any other terminal (basic) | Board, status, search and summaries work; resume by copying the command |
| **OS** | macOS (full), Linux (basic) | cmux is macOS-only, so on Linux you get the board, status and search without tab control. CI runs the tests and a demo smoke test on both |
| **Trackers** | GitHub (via `gh`), Jira Cloud, Linear | Status of PRs, issues and tickets linked to a thread |
| **Chat** | Slack | Read a thread to start from it; post a reviewed update back |

## Quick start

### 1. Install cmux

cmux is a free macOS terminal built for running AI coding agents in tabs. Thread Desk talks to it to see
your tabs and close or open them for you.

- Download: [cmux-macos.dmg](https://github.com/manaflow-ai/cmux/releases/latest/download/cmux-macos.dmg),
  open it and drag cmux to Applications, or
- Homebrew:

  ```sh
  brew tap manaflow-ai/cmux
  brew install --cask cmux
  ```

More at [cmux.com](https://cmux.com) and [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux).

### 2. Install Claude Code

Follow the [Claude Code docs](https://code.claude.com/docs), then run `claude` in a few cmux tabs as you
normally would. Thread Desk also lists sessions you ran before installing it.

### 3. Start Thread Desk from a cmux tab

```sh
npx thread-desk
```

It prints a link and opens the board in your browser. Start it **inside a cmux tab**: by default cmux only
accepts control from programs running inside it (see [Troubleshooting](#troubleshooting)).

To run from source instead:

```sh
git clone https://github.com/9hNguyen1432/thread-desk && cd thread-desk
npm install && npm run build
node dist/server/cli.js        # or `npm link` once, then `thread-desk`
```

Want to look around first? `npx thread-desk --demo` shows sample threads without reading your own.

### 4. Optional setup

- **Ticket keys:** open Settings and add your prefixes (`ENG`, `OPS`, …). Thread Desk suggests the ones it
  sees in your prompts.
- **PR status:** `gh auth login` once.
- **Instant updates:** `npx thread-desk hooks install` (see [Live hooks](#live-hooks-optional)).
- **Jira, Linear, Slack:** set the environment variables in [Configuration](#configuration).

## What it does

- **Today.** A todo list per day. Paste a Slack message, ticket or PR link and it becomes a todo. Threads
  link to it when you start them from the todo, when they mention the exact same Slack thread, ticket or
  PR, or when you accept a suggestion; nothing links behind your back otherwise. A todo turns WIP when one
  of its threads gets a prompt, unfinished todos move to the next day with the day they were reported,
  and wrapping up the day offers to mark done the todos whose threads, PRs or tickets are finished.
- **Bring in your open threads.** Starting fresh with thirty tabs open? One click turns them into
  todos, one per ticket, ticking the ones you touched in the last three days.
- **Kinds of work.** Threads get a label such as Support, Feature or Bug from their branch and first
  prompt, or the one you pick in the thread drawer or right in Cleanup, for one tab or many at once.
  Filter the board and cleanup by label. Claude Haiku can label the rest if you turn it on.
- **Ask several threads at once.** Pick threads and ask them all the same question, for example a
  summary of each support case. Each thread answers in a read-only copy, one at a time, so nothing in
  it changes. Edit the answers, then copy them as one message, save them to a file, or hand them to one
  new thread, so a single session makes any follow-up change instead of many sessions fighting over
  the same files.
- **Log.** What you actually worked on each day: todos done or in progress that day, work that was not
  on your list, and estimated time per todo and project from message timestamps. Copy it as text or
  download CSV for a timelog, and see the week at a glance.
- **Board.** Every session is a strip in a column: *Needs you*, *Running*, *Idle* (open tab), *Paused*
  (no tab), plus your own *Waiting on others*, *Done* and *Archived*. Filter by project; worktrees are
  grouped under their repository.
- **Done closes the loop.** Drag a thread to Done and Thread Desk asks whether to close its terminal tab
  too. The thread stays resumable.
- **Links.** Ticket keys (`ENG-1442`), GitHub PRs and issues, Slack threads and Figma files are pulled out
  of branches, titles and your prompts and shown as chips. PRs a session opened are tracked separately
  from PRs Claude merely mentioned.
- **Find anything** with <kbd>⌘K</kbd>: paste a ticket key, a PR URL or a Slack permalink, or type words
  from the conversation (accent-insensitive, so `phan doan` finds `Phán đoán`). <kbd>Enter</kbd> jumps to
  the open tab or resumes the session in a new one.
- **Cleanup.** Lists open tabs that are safe to close (marked done, their PRs merged or closed, their
  ticket done, or idle for a day) with the memory each one uses, and closes them in bulk. Tabs where
  Claude is working or waiting on you, or where anything besides Claude runs, are never suggested.
- **Inbox.** Threads waiting for you, oldest first, with the last thing Claude said.
  <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>Enter</kbd> to jump, <kbd>d</kbd> done, <kbd>x</kbd> snooze.
- **Tickets.** Threads, PRs, Slack threads and Figma files grouped by ticket, with Jira or Linear status.
- **Start from a ticket.** Paste a ticket key, GitHub issue or Slack link; Thread Desk drafts a branch
  name and first prompt, optionally creates a git worktree, and opens Claude in a new tab.
- **Digest and updates.** A copy-ready summary of what got done, and a drafted update you can post to the
  Jira ticket or Slack thread after reviewing it.
- **AI summaries (opt-in).** A four-line recap per thread: goal, done, next, blocker.

## Requirements

- macOS with cmux for the full experience (any OS for the basic board)
- Node.js 22 or newer
- Claude Code 2.x
- Optional: the GitHub CLI for PR and issue status

## How it works

| Data | Source |
| --- | --- |
| Threads, titles, branches, messages | `~/.claude/projects/*/*.jsonl`, read incrementally into SQLite with full-text search |
| Live status | `claude agents --json`, the cmux sidebar status, and (optional) Claude Code hooks |
| Tabs and memory | `cmux top`, `cmux list-workspaces`, `cmux surface resume show` |
| PR and issue status | `gh pr view`, `gh issue view` |
| Ticket status | Jira Cloud REST or Linear GraphQL, with credentials from environment variables |

The transcript format is internal to Claude Code and can change between releases. Thread Desk reads it
defensively and ignores anything it does not recognize; status that matters comes from the supported
`claude agents` command.

Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Thread Desk keeps its own
index, so old threads stay searchable, but they can only be resumed while the transcript exists. Raise
`cleanupPeriodDays` in `~/.claude/settings.json` if you want to resume older threads.

## Live hooks (optional)

Without hooks, status refreshes every few seconds. For instant updates and the exact last message in the
inbox:

```sh
npx thread-desk hooks install     # backs up ~/.claude/settings.json first
npx thread-desk hooks uninstall
```

This adds `http` hooks for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd`
that post to `127.0.0.1` with a shared secret. If Thread Desk is not running, Claude Code carries on
normally.

## Configuration

Settings live in `~/.thread-desk/config.json` (created on first run) and most can be changed from the
Settings dialog.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4545` | Port to listen on (loopback only) |
| `links.ticketKeys` | `[]` | Ticket prefixes such as `["CN", "OPS"]`; Settings suggests the ones it sees |
| `onDone` | `"ask"` | When a thread is marked done: `ask`, `close` the tab, or `keep` it |
| `cleanup.idleHours` | `24` | Suggest closing tabs idle this long (0 turns it off) |
| `resumeCommand` | `claude --resume {sessionId}` | Command used to resume, e.g. add `--permission-mode` |
| `recap.enabled` | `false` | AI summaries via `claude -p --model haiku` (no tools, no hooks, no saved session) |
| `trackers.jira.site` | `""` | e.g. `yourteam.atlassian.net` |
| `trackers.jira.keys` / `trackers.linear.keys` | `[]` | Which prefixes belong to which tracker |
| `start.branch`, `start.prompt`, `start.worktreeDir` | see file | Templates for starting a thread from a ticket |
| `labels.names`, `labels.rules` | Support, Feature, Bug, ... | Label names, and regex rules on branch or title and first prompt (first match wins) |
| `labels.ai` | `false` | Label recent unmatched threads with Claude Haiku (at most 100 a day) |
| `ask.model`, `ask.templates` | `sonnet`, 3 templates | Default model and saved questions for asking several threads |
| `day.startHour` | `4` | Local hour a new day starts, so late-night work counts for the day before |
| `day.idleGapMinutes` | `20` | Gaps between messages longer than this do not count as working time |

Credentials are read from the environment and never written to disk:

| Variable | Used for |
| --- | --- |
| `THREAD_DESK_JIRA_EMAIL`, `THREAD_DESK_JIRA_TOKEN` (`THREAD_DESK_JIRA_SITE`) | Jira status and comments |
| `THREAD_DESK_LINEAR_KEY` | Linear status |
| `THREAD_DESK_SLACK_TOKEN` | Reading a Slack thread when starting from it, posting updates |
| `THREAD_DESK_HOME` | Data directory (default `~/.thread-desk`) |

## Privacy and security

- Runs on `127.0.0.1` only and rejects requests addressed to any other host name.
- The board needs an access key. The link printed at startup carries it after `#`, which browsers never
  send to a server; the board keeps it in storage that belongs to `127.0.0.1:4545` only and sends it as a
  request header. Cookies are not used because they are shared by every port on `127.0.0.1`.
  `thread-desk url` prints the link again.
- Write requests must be JSON from the board's own origin, so other web pages cannot trigger them.
- Commands run without a shell and with validated arguments.
- Closing fails safe: a tab is only closed when it holds a single terminal whose foreground program is an
  idle Claude session or an idle shell, and live status is current. Splits, dev servers, editors, busy
  sessions and sessions waiting on a permission prompt are never closed.
- No telemetry. The only network calls are the integrations you configure.
- Data lives in `~/.thread-desk` (index, settings, access key). Delete the folder to remove everything.

## Commands

```text
thread-desk [--port 4545] [--no-open] [--data-dir path] [--claude-dir path] [--terminal auto|cmux|none]
thread-desk --demo        # sample data, no access to your real sessions
thread-desk url           # print the board link
thread-desk hooks install | uninstall | status
```

## Troubleshooting

**"cmux refused the connection."** cmux's default socket mode only accepts processes started inside
cmux. Run `thread-desk` from a cmux tab, or set a socket password in cmux settings and export
`CMUX_SOCKET_PASSWORD` before starting Thread Desk.

**A tab is never offered for closing.** The thread's details show why: it has splits or several tabs,
another program is in the foreground, or Claude's state is unknown. Close those in cmux yourself.

**A thread shows "transcript expired".** Claude Code deleted it (see `cleanupPeriodDays`). It remains
searchable but cannot be resumed.

**Memory numbers look high.** They are each tab's physical footprint, the same number Activity Monitor
shows, which includes compressed memory.

## Development

```sh
npm install
npm run build          # server (tsc) and web (Vite)
npm test               # vitest, one worker
node dist/server/cli.js --demo --port 4646
npm run dev:web        # Vite dev server proxying /api to an instance on port 4545;
                       # open http://localhost:5173/#t=<key from `thread-desk url`>
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding terminal or tracker adapters.

## Roadmap

Terminals already plug in through a small adapter interface. Agents will get the same treatment: today
the session reader is written for Claude Code, and the first step for Codex is to split it into an
agent adapter.

- **More agents:** OpenAI Codex CLI first, then OpenCode and Gemini CLI. cmux already tracks these
  agents in its sidebar, so status works the same way; what is missing is reading their session history.
- **More terminals:** tmux, WezTerm, Ghostty and iTerm2 adapters for people not on cmux, which would also
  bring tab control to Linux.
- **Smarter cleanup:** close tabs automatically when their PR merges, if you opt in.
- **Team view:** share which threads touch which tickets with teammates, without sharing transcripts.

Ideas and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). If you use another agent or
terminal, an issue describing where it keeps its sessions is the most useful first step.

## License

MIT
