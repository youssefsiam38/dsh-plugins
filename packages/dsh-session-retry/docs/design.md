# dsh-session-retry design

Maintainer notes. User-facing behavior and the public contract are in the [README](../README.md).

## Goals

- A turn that fails on a transient problem ends normally; the session never sits in "running" while it waits.
- The session continues by itself on a backoff that grows from one second to days, and gives up after a bounded budget (25 attempts, about 20.4 days of waiting by default).
- A person's new message, `/retry stop`, success, or exhaustion ends the chain.
- Installable on stock dsh with `dsh plugin add`, removable without leaving unreadable sessions, and built only on public upstream seams.

## Why no event types of its own

`Session.append` has no way to mark a new event `ignorable: true`, and a stored event whose type the reader does not know and that is not marked ignorable makes the whole session unreadable. A plugin-defined event type would therefore break sessions for anyone who uninstalls the plugin. The plugin instead derives its entire state from events dsh always writes, plus the clock:

| Fact | Source |
|---|---|
| The failure being retried | The latest `turn/end`, with the turn's `tool/call` / `tool/result`, `llm/retry`, and `request/context` events |
| Its attempt number | The `session-retry` source on the `user/message` that started that turn (1 when a person or another producer started it) |
| A retry was sent | A `user/message` with source kind `session-retry` after the failure |
| Cancelled by a person | A `user/message` with source kind `user` after the failure |
| Stopped | `command/run` `retry stop` followed by a successful `command/done` |
| Slot times | Pure function of (session id, failing `turn/end` seq and time, attempt) — see `src/policy.ts` |
| Skipped slots | Time: every slot before now without a sent continuation |

The only model-visible input the plugin adds is the continuation `user/message`, so "model-visible ⟺ logged" holds.

## Components

| File | Role |
|---|---|
| `src/policy.ts` | Backoff math: `n^exponent` seconds after failed attempt `n`, ±`jitterRatio`, capped at the largest 64-bit nanosecond duration; seeded jitter; slot schedule. |
| `src/fold.ts` | Pure, JSON-serializable fold of standard events into `RetryFoldState`. |
| `src/decision.ts` | First-match condition evaluation, the client view, and `phaseAt(view, now)`. |
| `src/projection.ts` | `session-retry` session projection: persists the fold, publishes the view computed with the live conditions. |
| `src/runtime.ts` | One driver per live root agent: timer for the next slot, readiness preflight, `ready` subscription, continuation send. |
| `src/index.ts` | `sessionRetry` service: condition registry, built-ins, runtimes, `/retry now|stop`. |
| `src/client/*` | Browser block in `conversation.input.dock`, locale dictionaries, stylesheet. |

## Seams used

`agents` (`agent/created`, `agent/status`, `roots()`, `followup()`), `sessions` (`session/event`), `sessionProjections` (`register`, `stateOf`), optional `commands` (`register`), and on the client `slots`, `sessions.binding().session.command()`, `locale`, and `useProjection`. `agent-loop` is untouched.

## Timing rules

- After failed attempt `a`, slot `a+1` is one backoff after the failure; slot `k+1` is one backoff after slot `k`. The give-up time is one backoff after the last slot.
- When a slot comes due and the agent is idle, the runtime asks `isReady`. Ready: send the continuation for that slot. Not ready: nothing is written, and the runtime arms the next slot.
- A `ready` signal sends the latest unsent due slot, or else the next slot, immediately.
- While the agent is busy the runtime waits for its idle transition. A session whose agent is not loaded does nothing; when it loads, the latest missed slot runs once.

## Known limitations

- Retries run only while the session's agent is live, like dsh's scheduled reminders.
- Condition changes (a plugin registering or removing a condition) re-drive live runtimes but do not republish an unchanged projection until the next relevant event.
- The Web transcript shows the continuation with the client's generic row for unknown message producers.
