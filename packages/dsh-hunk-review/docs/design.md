# dsh-hunk-review design

Maintainer notes. User-facing behavior is in the [README](../README.md).

## Components

| File | Role |
|---|---|
| `src/hunks.ts` | Pure rules: hunk sides, text to lines and back, placement of each hunk in the current lines, the reverse patch of chosen hunks, and the conflict drift. |
| `src/review.ts` | `TurnReviewer`: reads a turn's summary and comparisons from `ctx.workspaceChanges`, reads files through `ctx.fs`, builds the review, and reverts with one version-guarded write per file. |
| `src/message.ts` | The note to the agent: framing, tag escaping, byte budget. |
| `src/index.ts` | `hunkReview` service: config, kept-hunk memory, target selection, the `/api/hunk-review/*` routes, and the `agent.inject()` of the note. |
| `src/client/*` | Browser: the `hunk-review` Turn data, the turn-tail chip, the right-sidebar tab type and body, the review store, dictionaries, stylesheet. |

## Prior art

| Product | Review unit | Actions | Agent told about rejections |
|---|---|---|---|
| Zed agent panel | Hunk, file, all; multi-buffer review tab and inline in files | Keep / Reject per hunk and for all ([docs](https://zed.dev/docs/ai/agent-panel)) | Requested when rejecting during generation ([issue 48135](https://github.com/zed-industries/zed/issues/48135)) |
| VS Code Copilot edits | Change chunk, file, all | Keep / Undo, Up / Down navigation, auto-advance to the next pending change ([docs](https://code.visualstudio.com/docs/copilot/chat/review-code-edits)) | Not by the review itself; checkpoints restore earlier state ([docs](https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints)) |
| Cursor agent | Hunk, file, all; bottom review bar with file navigation | Keep All / Reject All, per-hunk accept / reject ([docs](https://cursor.com/docs/agent/review)) | No |
| Aider | Whole edit (one git commit per change) | `/undo` reverts the last commit ([docs](https://aider.chat/docs/git.html)) | Undo is part of the chat |

Taken from them: Keep / Revert at hunk, file, and turn level (all three); keyboard navigation that moves to the next hunk after a decision (Copilot's `revealNextChangeOnResolve`); a review surface beside the conversation rather than in the transcript (Zed's review tab). Added: the agent is told what was reverted, because dsh's rule is that model-visible input is logged and an agent that does not know its edit was undone tends to reapply it.

## Libraries

| Library | Considered for | Decision |
|---|---|---|
| jsdiff (`diff`) | Hunks, reverse patches (`reversePatch`, `applyPatch` with `fuzzFactor`) ([repo](https://github.com/kpdecker/jsdiff)) | Used on the Host for the conflict drift (`diffArrays`), inlined into `lib/index.js`. `@deepseek-ai/dsh-workspace-changes` already produces its hunks with jsdiff 9, and `dsh-better-sidebar` depends on it too. |
| diff-match-patch | Character-level fuzzy patching | Not used: fuzzy application is the opposite of the exact-match rule below. |
| `@git-diff-view/react`, `react-diff-view` | Rendering ([git-diff-view](https://github.com/MrWangJustToDo/git-diff-view), [react-diff-view](https://github.com/otakustay/react-diff-view)) | Not used: per-hunk buttons and statuses need a custom row anyway, and a second styling system would not match the Web client. The tab draws plain rows with the same `--dsw-alias-file-diff-*` tokens `ui-deliverables` uses. |
| Monaco / CodeMirror merge view | Side-by-side editing | Not used: large bundles for a review that does not edit. `dsh-better-sidebar` bundles CodeMirror for its editor; nothing here needs an editor. |

The reverse patch is written here (about 40 lines in `reverseHunks`) instead of `applyPatch(reversePatch(...))` because the review needs the placement of every hunk anyway (to show pending, kept, reverted, and conflict), and one placement function serving both the status and the revert keeps them from disagreeing.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Baseline | Turn start, as recorded by `ctx.workspaceChanges` | The Web bundle already records it per top-level turn (git snapshots plus file-tool captures) and serves each file's hunks through a public service. A second snapshot mechanism would duplicate storage and disagree with the changed-files card. Sessions without the recorder get no review. |
| Scope | One review per turn | That is the unit the recorder keeps. A session-wide review would need a baseline the recorder does not keep. |
| Status | Computed from the file every time | No stored revert state can go stale: a hunk is reverted when its turn-start lines are in the file, pending when its turn-end lines are, and a conflict otherwise. |
| Matching | Exact lines, nearest occurrence to the expected line | A revert must never write over lines the user changed. The expected line moves by the size difference of reverted earlier hunks of the same file. |
| Write | `ctx.fs.writeText` with `replaceIfVersion` / `createIfAbsent` | The file service is the seam every execution world implements (local, sandboxed, remote). The version from `stat` before the read guards the whole read-compute-write. |
| Bulk actions | Act on pending hunks only | A kept hunk was decided; Revert all should not undo that. Reverting a kept hunk one at a time stays possible. |
| While the agent runs | Refuse reverts (configurable) | The agent may be writing the same file; the recorder also attributes edits during a turn to that turn. |
| Keep | In-memory per `sessionId:seq` | Keeping changes nothing on disk and nothing the model sees; the recorded changes are in memory for the same lifetime. |
| Model notice | One `user/message` with source `hunk-review` through `agent.inject()` | Existing durable path (`agent/inbox/spliced`, then `user/message`) that is logged and does not wake the agent; the same approach `dsh-user-shell` uses. No new event type, so uninstalling leaves sessions readable. |
| Created files | Reverting leaves an empty file | `ctx.fs` has no delete. Running `rm` through `ctx.subprocess` would bypass the file-service seam. |
| Entry point | Turn-tail chip plus a right-sidebar tab type | The chip is where the turn ends; the tab keeps the review beside the conversation and survives reloads (the sidebar persists tab addresses). The address `dsh-resource://hunk-review/session/<id>/<seq>/<turn>` carries everything the body needs. |
| Turn data | Own `hunk-review` Conversation definition | Reads `workspace/changes` directly instead of `ui-deliverables`' private Turn data, so the chip does not depend on that package's internals. |

## Seams used

| Seam | Owner | Use |
|---|---|---|
| `ctx.workspaceChanges.summary` / `.diff` | `@deepseek-ai/dsh-workspace-changes` | Baseline hunks per turn |
| `ctx.fs.resolve` / `stat` / `readText` / `writeText` | `@deepseek-ai/dsh-fs` | Current file, guarded write |
| `ctx.connection.fetch.register` | Web connection | Authenticated routes |
| `agent.inject()`, `agent.status` | `@deepseek-ai/dsh-agent` | Note to the model; refusal while running |
| `MessageSourceMap['hunk-review']` | `@deepseek-ai/dsh-llm` | Typed message source |
| `uiConversation.events.register` | `dsh-client-ui-conversation` | `hunk-review` Turn data from `workspace/changes` |
| `conversation.chat.turnTail` | `dsh-client-ui-chat` | The chip |
| `ctx.sidebarRightTabs.register`, `sidebar.right.pane.tab`, `ctx.sidebarRight.openResource` | `dsh-client-ui-sidebar-right` | The review tab |
| `ctx.locale.register` | `dsh-client-locale` | `en` / `zh` dictionaries |

## Known limitations

See the README. Maintainer-relevant: the review route reads every listed file on each load (bounded by `maxFiles` and `maxFileBytes`); a turn with hundreds of large files makes Re-diff slow. Summaries for the chip are cheap (memory only).
