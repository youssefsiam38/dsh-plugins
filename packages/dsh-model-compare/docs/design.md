# dsh-model-compare design

Maintainer notes. User-facing behavior and configuration are in the [README](../README.md).

## Goals

- One prompt, 2–4 models, answers side by side in the session you are in, with the numbers that matter for choosing (time to first token, total time, tokens, speed, cost).
- Continuing with one answer is one explicit click, and the conversation then goes on with that model and that answer as if it had been the only one.
- A comparison can never have several agents changing the same workspace at the same time.
- Cheap by default: bounded model count, capped answer length, no tools, no automatic titles for the lanes.
- Installable on stock dsh with `dsh plugin add`, built only on public seams, and removable without leaving unreadable sessions.

## Research

What comparable products do, and what this plugin takes from each:

| Product | Behavior | Taken |
|---|---|---|
| OpenRouter Chatroom | Pick several models; each answers every message in its own column ([chat](https://openrouter.ai/chat), [compare page announcement](https://x.com/OpenRouterAI/status/1904922319388041611)). Per-request `usage` includes tokens and `cost`, delivered in the final SSE chunk ([usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)); latency means time to first token and throughput means output tokens per second ([provider performance](https://openrouter.ai/blog/insights/evaluate-llm-provider-performance/)). | Columns; per-column TTFT, total time, tokens, tok/s, and provider-reported cost with the same definitions. |
| ChatGPT "Which response do you prefer?" | Two answers side by side; clicking anywhere on one picks it, which users report as accidental picks and ask for an explicit select button ([community thread](https://community.openai.com/t/incorrect-use-of-ui-ux-when-choosing-which-response-do-you-prefer/596139)). | A dedicated **Continue with this answer** button; nothing else in a column changes the conversation. |
| LMArena battle mode | Two anonymous models answer side by side, follow-ups go to the same pair until you vote ([help](https://help.arena.ai/articles/4489017547-how-to-use-battle-mode)); FastChat's arena caps output at 2000 tokens by default and limits turns and input length ([source](https://huggingface.co/spaces/kanhatakeyama/chatbotarena-ja/blob/111fd9770917f619ce705e279e71c875954dcc35/serve/gradio_block_arena_anony.py)). | Output-token cap and prompt-length cap as configuration. |
| Google AI Studio compare mode | Two models side by side with latency and response tokens ([announcement](https://developers.googleblog.com/compare-mode-in-google-ai-studio/)). | Stats in each column header. |
| Open WebUI multi-model chats | Parallel columns, stacked on small screens ([docs](https://docs.openwebui.com/features/chat-conversations/chat-features/multi-model-chats/)); mobile uses scroll snapping to swipe between models, with an optional one-model-at-a-time tab mode ([overview](https://deepwiki.com/open-webui/open-webui/5.5-multi-model-response-display)). Click-anywhere branch selection, an unsaved choice, and the last model being active by default are reported problems ([issue 30306](https://github.com/open-webui/open-webui/issues/30306)). | Phones: one column per screen in a scroll-snap strip plus a tab per model. The choice is saved on the Host (the comparison record), never implied. |
| TypingMind multi-model responses | A primary answer is marked for follow-up context while each model keeps its own thread ([docs](https://docs.typingmind.com/manage-and-connect-ai-models/activate-multi-model-responses)). | Each lane is its own session (its own thread); adopting makes one lane's thread the conversation. |
| Cherry Studio | Nested horizontal/vertical scrolling in a multi-model row needed fixes for wheel and trackpad gestures ([PR 20088](https://github.com/CherryHQ/cherry-studio/pull/20088), [PR 20755](https://github.com/CherryHQ/cherry-studio/pull/20755)). | Lanes contain their own vertical scroll (`overscroll-behavior: contain`); the strip scrolls horizontally only on phones. |
| Per-panel state | Each panel keeps its own status (queued, streaming, complete, error, cancelled) and avoids aggregate "models agree" badges ([article](https://dev.to/zhebuildsthings/designing-a-multi-model-answer-grid-without-hiding-uncertainty-57e6)). | Per-lane status pill and per-lane Stop. No aggregate verdict. |
| Cost limits | SageMaker Canvas compares at most 3 models and warns that each is billed ([docs](https://docs.aws.amazon.com/sagemaker/latest/dg/canvas-fm-chat-compare.html)); OpenRouter limits the estimated cost of concurrent requests and returns 402 `in_flight_budget_exhausted` ([limits](https://openrouter.ai/docs/api/reference/limits)). | At most 4 models (configurable down to 2), a billing note on the setup form, and the output cap. |

No product documents synchronized scrolling across columns; it is offered here as a toggle (on by default on desktop) that keeps lane scrollports at the same relative position. No source covers tool use during comparisons; turning tools off follows from running N agents in one workspace, where concurrent writes would race (Open WebUI and TypingMind likewise continue only one branch).

## Why lanes are sessions

A lane is an ordinary dsh session forked from the source: its own log, model, and live stream, visible in the sidebar while the comparison is open. That gives streaming, persistence, reload, stop, and statistics from existing machinery, and makes adoption a standard fork. The alternative, N model calls outside the agent loop, would bypass the session log ("model-visible ⟺ logged") and every provider/route/retry seam.

## Seams used

| Need | Seam |
|---|---|
| History to compare against | The live source session's events, cut at the latest completed turn (`src/fork.ts`, the same rule as the controller's `session/fork`), seeded with `buildForkSeed` (`@deepseek-ai/dsh-session`). |
| Lane creation with a chosen id, model, and effort | `ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { cwd, parentSession, isSeeded, agentPreset }, agentOptions: { provider, model, reasoningEffort, maxTokens }, setup })`. The controller's `session/fork` cannot be used for lanes: it picks the id, always starts on the default model, and has no setup hook, so neither the model nor the tool policy could be applied before the first request without changing the global default model through `selectModel`. |
| Same persona as the source | `ctx.agentPresets.mount(agentCtx, presetId)` in the lane's setup, with the source's `agentPreset` projection value. |
| Tool policy | `agentCtx.tools.restrict({ allow })` plus `agentCtx.tools.guard(...)` in the lane's setup (`src/policy.ts`), the mechanism subagents use for `toolFilter`. |
| Policy after a restart or a resume from the sidebar | A serial `agent/created` listener re-applies the policy when the agent's id is in the lane index; creation fails if it cannot be applied. |
| Lane index and comparison records | Storage domain `model_compare` (`ctx.storageDomain`, per-record layout). |
| Workspace grouping, archive | `ctx.workspaceRegistry.list()` / `workspace.attachSession()` / `archiveSession(id, { stopActivity: true })`. There is no session delete API in dsh; archived sessions stay readable and can be unarchived. |
| Lane titles | `ctx.sessionTitle.rename()`, which also pins the title so no automatic title request is made for a lane. |
| The prompt | `agent.followup(createUserMessage({ source: { kind: 'user' } }))` on each lane. |
| Stop | `agent.cancel({ kind: 'user' })`. |
| Adoption | `ctx.sessionController.fork({ sessionId: lane })` (the Web client's own fork path): an ordinary session with the lane's history, attached to the workspace, composed by the controller (preset, model selection) and therefore unrestricted. Its model is the lane's, because the controller's selection falls back to the last logged request header. |
| Model list | `ctx.sessionController.modelCatalog()`; requested models must be in it. |
| Statistics | Session projection `model-compare` (`src/stats.ts`, `src/projection.ts`) folded from `turn/start`, `assistant/message`, `assistant/attempt`, `turn/end` and envelope times; read in the browser with `useProjection('model-compare')`. |
| Browser transport | `ctx.connection.fetch.register` routes below `/api/model-compare/` (authenticated like every Web route). An external plugin cannot mount a typed Remote namespace (the Web client only accepts generated strict codecs). |
| Compare tab | `conversation.view` list entry `model-compare`, like the Trajectory view. |
| Lane columns | A plugin-declared session-scoped slot `model-compare.lane`, rendered inside `SessionProvider` bound to the `SessionReference` from `ctx.sessions.retain(laneId, { source: 'modelCompare' })`; the slot gets `useSession`, `useProjection`, and the lane's `eventSource` through its inject face. |
| Rendering answers | `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives` (a shared shell module). |
| Switching to the continuation | `uiWorkspace.openSession(id)`, read structurally at runtime. |
| Model picker order | Read-only view of `dsh-model-switcher`'s `localStorage` favorites and recents (`dsh-model-switcher:v1`, keys `provider\0model`). |

`agent-loop` is untouched and the plugin adds no session event types.

### Why the stock Chat view is not embedded

`ui-chat` exports no components, and its Chat renders only through Conversation slots. Inside a `conversation.view` entry those slots are unavailable: `conversation.session` is declared by the `conversation.content` factory (a second declaration is refused), and rendering `conversation.content` from inside itself is refused as recursive. The lane columns therefore use a compact transcript (`src/client/transcript.ts`) folded from the lane's event window: answers (settled messages, and live chunks while streaming) through the dsh Markdown renderer, reasoning in a disclosure, one row per tool call with its outcome, and turn errors. A lane opened from the sidebar shows the full stock Chat.

## Tool policy details

- `none` (default): `restrict({ allow: [] })` hides every tool the lane inherits (global and preset tools), and the guard denies every call.
- `read-only`: the configured allowlist, narrowed to the tools the lane actually has (`restrict` fails on unknown names; narrowing never widens). The guard allows exactly those names.
- `all`: nothing is restricted. The setup form says that several models may change the workspace at once.
- `restrict` does not filter tools registered on the lane's own agent scope. In some Web profiles the `subagent` tool is registered that way (with model-selection settings), so it stays in the lane's tool list; the guard denies its calls. The guard also covers PTC `run_code`, which `restrict` leaves visible; in PTC mode no tool can run in a lane unless `run_code` is allowlisted.
- The policy is not stored in the lane's log: it comes from the lane index each time the lane's agent is created. With the plugin uninstalled, lanes are ordinary sessions (they are archived once their comparison closes).

## Statistics

Computed for the lane's first own turn only (the comparison turn):

- time to first token: `turn/start` time to the first token in the first answer stream (`assistantStreamFirstTokenTime`), so a retried attempt's wait counts;
- total: `turn/start` to `turn/end`;
- tokens: summed `usage` of every request of the turn, including failed attempts (`assistant/attempt`); input counts uncached, cache-read, and cache-write tokens;
- speed: output tokens over first token → last answer;
- cost: sum of provider-reported `costUsd` (read structurally; builds whose `TokenUsage` lacks it show "cost not reported"). dsh has no price table, so nothing is estimated.

## Known limitations

- The Compare tab is not shown on a blank session (the Conversation shell hides views until the first message). Send a first message, then compare.
- The lane columns are a compact transcript, not the stock Chat (see above).
- Lanes appear in the sidebar while the comparison is open; dsh has no hidden-session flag short of `origin: 'subagent'`, which would make lanes unreachable for adoption.
- The source must not be a lane, and one comparison per source can be open at a time.
