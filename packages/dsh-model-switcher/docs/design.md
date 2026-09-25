# dsh-model-switcher design

Maintainer notes. User-facing behavior is in the [README](../README.md).

## Components

| File | Role |
|---|---|
| `src/index.ts` | Host half: validates the row `config` (schemastery) and publishes it as `__DSH_MODEL_SWITCHER__` through `webserver/index-inject`. |
| `src/settings.ts` | Settings shared by both halves, and the page-global parser (per-field fallback). |
| `src/client/index.ts` | Browser plugin: copy, styles, preferences, enrichment, and the `conversation.input.model` registration. |
| `src/client/ModelSwitcher.tsx` | Trigger, popover or sheet, both comboboxes, the grouped listbox, the effort row, and the focus cycle. |
| `src/client/search.ts` | Pure data: entries, provider options, match-sorter ranking, and sections. |
| `src/client/insights.ts` | Best-effort Remote reads for key status and model metadata, cached per Host generation. |
| `src/service.ts` | Types of the `modelSwitcher` service (`dsh-model-switcher/service`, a types-only export with no runtime code). |
| `src/client/pick-service.ts` | The `modelSwitcher` Cordis `Service`: `pick()` renders `Picker.tsx` in its own React root under `document.body`, one pick at a time. |
| `src/client/Picker.tsx` | Picker mode of the surface: the same `SwitcherPanel` without effort or session writes, excluded models filtered out, checks and Done for a multiple pick. |
| `src/client/catalog.ts` | The Host catalog for picker mode, read with `session.modelCatalog` (picker mode has no session directory) and marked stale by the same Host events as the enrichment. |
| `src/client/prefs.ts` | Favorites and recents in `localStorage`, synced across tabs. |
| `src/client/icons.tsx`, `marks.generated.ts` | Provider logos. `scripts/marks.mjs` copies the needed paths out of the pinned `simple-icons`, so the 5 MB package stays out of the bundle, the source map, and the tests. |

## Seams used

- **`conversation.input.model`** (declared by `ui-conversation`, kind `single`). Since dsh 0.1.7-rc.1, `SlotCore.register` lets entries shadow each other by `priority`: the lowest live entry renders, and the stock `ModelSelect` sits at 0. The picker registers at a negative priority. Unloading the plugin removes the entry, and the stock control renders again. There is no fork patch and no DOM surgery.
- **`ctx.modelDirectories`** (the `ui-model-selection` service). This is the same per-session `ModelDirectory` that the stock seat and `/model` use, so selection semantics, generation guards, composer blocking, and "session in use" handling stay the stock behavior. `directoryFor` runs on the caller's context and reads `remote.session`, so the registering scope injects `remote` and `remote.session` exactly as the stock plugin does. Without them the call throws "cannot get property without inject". The browser test caught this.
- **Remote namespaces** `llm`, `settings`, and `credentials`, all read-only, each optional (`ctx.get('remote.<ns>')`), and all validated as untrusted wire data.
- **Client service `modelSwitcher`**, registered like the stock `modelDirectories` (a `Service` subclass mounted with `ctx.plugin`). Consumers read it with `ctx.get('modelSwitcher')` at call time and check for `pick`, so the dependency stays optional; `dsh-model-compare` does this.
- **`webserver/index-inject`** to hand the validated config to the page. This is the pattern `ui-settings-models` uses.

The Settings pages have no model-picker seat. `ui-settings-models` is a provider editor, and its extension seats (`settings.models.provider-card`, `settings.models.footer`) add content but cannot replace controls. The model choice in `ui-settings-subagent` is a checkbox list inside the whole `plugins.item` card with id `subagent`. Replacing that card would mean re-implementing its limits and permission controls. The plugin therefore changes only the composer.

## Research

Surveyed on 2026-09-25.

| Product | What matters here | Source |
|---|---|---|
| Zed | Searchable list, provider logo per row, starred favorites in a top section, "No tools" label | https://zed.dev/docs/ai/agent-panel |
| VS Code Copilot | Picker grouped by provider. The Manage Models editor adds `@provider:` and `@capability:` filters and shows context size | https://code.visualstudio.com/docs/agent-customization/language-models |
| Open WebUI | Fuse.js fuzzy search over name, tags, and description. Pinned models on top. Arrows and Enter | https://deepwiki.com/open-webui/open-webui/9-model-management |
| OpenRouter | Faceted model browser: modality, context, price, provider. Rows show provider icon, context, and price | https://openrouter.ai/models |
| LobeChat | Group by provider or by model. Capability tags moved to a hover panel to keep rows calm | https://github.com/lobehub/lobehub/pull/19930 |
| T3 Chat | Users asked for better search and favorites after a grid layout | https://feedback.t3.chat/p/better-model-picker |
| Claude.ai, ChatGPT | Short curated lists, effort or thinking in the same menu, no search | https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings |
| Raycast, Linear-style palettes | One fuzzy input. Recents first when the query is empty. Ctrl+N/P, Enter, Esc | https://manual.raycast.com/ai/ai-chat, https://github.com/k1-c/linear-tui/issues/51 |
| dsh-t3-model-picker | Prior dsh plugin. Replaces the same slot at priority -1 with a provider rail, tiered search, and Cmd+1–9 | https://github.com/yusufameri/dsh-t3-model-picker |

Guidance sources:

- WAI-ARIA APG combobox: focus stays in the input, and `aria-activedescendant` points at the active option (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
- APG listbox: groups with `role="group"` and a label (https://www.w3.org/WAI/ARIA/apg/patterns/listbox/).
- NN/g on filters and facets (https://www.nngroup.com/articles/filters-vs-facets/).
- NN/g on no-results pages (https://www.nngroup.com/articles/search-no-results-serp/).
- NN/g on bottom sheets (https://www.nngroup.com/articles/bottom-sheet/).
- Material 3 on bottom sheets (https://m3.material.io/components/bottom-sheets/guidelines).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Two stages | The provider select sits above the model search. It is an interactive filter, not a required step. The popover opens on the model search with "All providers", and `initialFocus: providers` opens on the provider search. Picking a provider hands focus to the model search. | The owner asked for two stages. Zed, VS Code, and palettes show that one search box is the fast path, and NN/g says a filter that applies at once suits one criterion at a time. |
| Ranking | match-sorter tiers (exact, prefix, word prefix, substring, acronym, in-order characters) over name, then id. Provider name and id are capped at the lowest tier. Multiple words must each match, and their ranks add up. Ties go to favorite, then recency, then directory order. Provider groups are ordered by their best hit. | The tiers are predictable. The cap keeps a match on the model name above a match on the provider name. |
| Grouping | Sections are grouped by provider, each with its logo in the heading. Favorites and Recent appear only while the search is empty. | Zed and Linear do the same. With a query, the ranked groups are what matters. |
| Badges | Context window (`200K`), **Vision**, **Reasoning**, and **Needs key**. At most four, all compact. | They carry what the Host can tell the browser. Cost and tool support are not on the wire, so they are left out rather than guessed. |
| Favorites and recents | Stored per browser in `localStorage`, synced across tabs, and fail-soft. Recents show 5 by default, and 20 are stored. | No shared state is needed, and nothing reaches the Host or the model. |
| Keyboard | ↑↓ and Ctrl+N/P wrap. PageUp/PageDown move 8 rows. Enter picks. Esc clears the search, then closes. Tab and Shift+Tab cycle the focus stops. Mod+S stars. | APG, palette conventions, and the owner's Tab/Shift+Tab request. Mod+S is the only chord added, so no browser or composer chord is taken over except Save Page while the popover has focus. |
| Accessibility | Combobox, listbox, and group roles, with `aria-activedescendant`, `aria-selected`, `aria-busy`, and a polite count region. The star is mouse-only and hidden from assistive technology, because Mod+S is the keyboard path and a button inside an option is invalid. | APG |
| Mobile | At `max-width: 640px` the picker is a full-width modal bottom sheet (`aria-modal`), opaque, with a scrim, a Close button in the Tab cycle, 44 px rows, and 16 px inputs so iOS does not zoom. | NN/g and Material 3. Back-button dismissal is not implemented, and the README says so. |
| Empty, loading, error | Echoes the query and offers "Search all providers" and "Clear search". Shows "Loading models…" with `aria-busy`. Keeps the stock load error with Retry and the per-provider failure strips. | NN/g no-results guidance. The picker keeps every stock surface. |
| Theming | Only the `--dsw-alias-*` and `--dsw-specific-menu` tokens and elevation variables the stock control uses. Every class is `dms-` scoped. No resets. | Native in light and dark themes with no theme selectors. |
| Combobox implementation | Hand-rolled on dsh's own primitives (`useAnchoredPosition`, `useDismissOnOutsidePointer`, `Toast`, icons). | cmdk 1.1.1 pulls in Radix Dialog (about 15 kB gzipped) and has had no release in 18 months. React Aria Components (about 274 kB gzipped whole) is too heavy to inline. Ariakit and Headless UI add their own popover and positioning next to dsh's. The APG pattern is about 200 lines. |
| Fuzzy matcher | match-sorter 8.3.0, about 3.3 kB gzipped | Its tiers map onto the ranking decision. fuse.js scores are harder to rank predictably. uFuzzy and command-score are less suited or unmaintained. |
| Virtualization | None | A few hundred rows render fine, and a query shrinks the list. @tanstack/react-virtual 3.14 would complicate sticky headings and `aria-setsize`. |
| Slot priority | -10, configurable | Avoids colliding with dsh-t3-model-picker at -1. At the same priority the second registration fails. |

## Behavior kept from the stock control

- Picking a model sends `{ provider, model }` with no effort, the same as the stock composer seat. The Host applies the model's default.
- The effort row offers exactly the advertised levels, plus Default when the adapter has no default.
- Picking the current value closes the popover without a write.
- A failed selection shows a toast, including the stock "session in use" copy, and keeps the popover open.
- Directory load failures show inline with Retry, and each provider's catalog failure shows as a warning strip.
- `locked` disables the trigger. Addressed subagent sessions render nothing.
- The composer's compact variables (`--dsh-composer-model-text-display`) hide the text.
- The trigger's accessible name includes the model and the effort.
