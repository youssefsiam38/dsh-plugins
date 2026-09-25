# dsh-user-shell design

Maintainer notes. User-facing behavior is in the [README](../README.md).

## Components

| File | Role |
|---|---|
| `src/record.ts` | Pure text rules shared by Host and browser: head+tail truncation, the model frame and its tag escaping, the `command/done` record text and its parser. |
| `src/askpass.ts` | The per-run `sh` prelude (private directory, `sudo` wrapper, askpass helper, cleanup), the FIFO answer and cleanup scripts, and the marker-line parser. |
| `src/runner.ts` | One run through `ctx.subprocess`: spawn, output decoding and marker stripping, timeout and cancel, password answers. |
| `src/hub.ts` | Live run state and the event-stream fan-out (coalesced output, bounded tail for late subscribers). |
| `src/index.ts` | `userShell` service: the `sh` / `shq` commands, the `/api/user-shell/*` routes, spill, the `agent.inject()` of `!` results, and the system-prompt line. |
| `src/client/*` | Browser: the `!` line-prefix source, the composer chip, the `user-shell` chat node and block, the event-stream store, dictionaries, stylesheet. |

## Why the command registry carries the record

A run must leave a durable record the user sees, and a `!!` run must leave nothing a model sees. The `command/run` / `command/done` pair already has these properties: it is log-only, the Web client renders it, and stock dsh keeps rendering it after the plugin is removed. A plugin-defined event type could not be marked `ignorable`, so an uninstall would make sessions unreadable. The route therefore starts every run with `ctx.commands.execute(agent, '/sh …')`, and the handler awaits the process. The fallback `/sh` / `/shq` commands are the same handler.

The route passes the browser tab's owner token to the handler through a one-entry "ticket" per session, which the handler consumes when it starts. That lets the route answer with the pairing id as soon as the run starts, while the command itself stays pending until the process ends.

## Why `agent.inject()` for `!`

`inject()` queues model-facing context without waking the driver. That is exactly "recorded, and the next message sees it". While a turn runs, the result joins the next step, so there is no need to wait for the turn boundary. The queue is logged (`agent/inbox/spliced`), and the claimed message is logged as a `user/message`, so the model-visible text is reconstructable. Queued context is dropped on cancel and dispose. The command record keeps the output visible to the user in that case (README, "What the agent sees").

## Chat node

The Chat target counts a session that has only `command` rows as blank, so a `!` typed into a new session would stay behind the empty-session composer. The plugin therefore folds each `sh` / `shq` pair into its own `user-shell` chat node (the pattern `ui-goal` uses for `/goal`). The node has the session location, so a run between two turns is not pulled into a turn's collapsed process group. The generic command row of `sh` / `shq` renders nothing.

## Password channel

See README, "How the password travels". Details that are easy to break:

- **Marker destination.** The helper writes the marker to `/proc/<prelude pid>/fd/9`, a copy of the prelude's stderr made at its start. dash applies a simple command's redirections in the parent while the command runs, so the prelude's own fd 2 points at stdout at that moment. When the copy cannot be opened (no `/proc`, or a socket, which is what the local subprocess provider uses), the helper writes to its own stderr. sudo passes that through, and the prelude merges it into stdout. The parser strips markers from both streams.
- **Forged markers.** A marker whose nonce does not match stays ordinary output.
- **No leak into a regular file.** The answer script refuses anything that is not an existing FIFO. That means a late answer (after the helper exited and removed its FIFO) is never written to a regular file.
- **Server-driven timeout.** The server owns the password timeout and answers `C` (refuse) when it expires. The helper has no timer of its own; a killed run takes the helper with it.

## Known limitations

- Up-arrow history recall needs a composer key seam that does not exist.
- The fallback `/sh` keeps the composer busy until the command ends, because the command RPC awaits the handler.
