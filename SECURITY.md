# Security

Thread Desk reads your Claude Code transcripts, which can contain source code, credentials pasted into
prompts, and personal data. It is built to keep that on your machine:

- The server binds to `127.0.0.1` and refuses requests whose `Host` header is not the loopback address
  and port it bound, which blocks DNS-rebinding attacks.
- Every API call needs the access key stored in `~/.thread-desk/token`, sent in the
  `x-thread-desk-token` header (the event stream, which cannot set headers, takes it as a query
  parameter). The key reaches the browser in the URL fragment, which is never sent to servers, and is
  kept in origin-scoped storage. No cookies are used: they would be sent to every port on `127.0.0.1`.
- Write requests must carry a JSON body and, when the browser sends an `Origin`, it must be the board's
  own origin.
- Closing a terminal tab fails safe: only a single-terminal tab whose foreground program is an idle
  Claude session or an idle shell can be closed, and only while live status is current.
- Hook calls from Claude Code are authenticated with a separate secret in `~/.thread-desk/hook-secret`.
- External commands (`claude`, `cmux`, `gh`, `git`) are run without a shell; session ids and tab
  references are validated against what the server already knows.
- Tracker and Slack credentials are read from environment variables and are never stored.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue. Include
the version, your OS and steps to reproduce. You will get a reply within a week.
