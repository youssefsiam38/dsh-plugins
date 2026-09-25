# dsh-command-menu design

A Cmd/Ctrl+K menu for the dsh Web UI that finds and acts on sessions, message text, slash commands, settings pages, workspaces, models, themes, and app actions. This note records what the research said, what the menu does because of it, and which dsh seams it uses.

## Research

| Source | What it says | What the menu does |
|---|---|---|
| Superhuman, [How to build a remarkable command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/) | One shortcut everywhere; the same shortcut closes it; show each command's shortcut; fuzzy and synonym matching; recency-aware ranking; hide commands that do not apply. | `Mod+K` toggles from anywhere, including text fields. Rows carry keywords (synonyms) in both languages. Actions appear only when the service behind them is loaded (no sidebar toggle without a layout, no Stop without a running turn). |
| Sam Solomon, [Designing command palettes](https://solomon.io/designing-command-palettes/); Mobbin, [Command palette](https://mobbin.com/glossary/command-palette) | Keep it keyboard-complete, discoverable, simple; group results. | Every row is reachable and runnable by keyboard; a sidebar button opens it for mouse and touch users. |
| saasui.design, [Search and command palette patterns](https://www.saasui.design/blog/saas-search-command-palette-ux-patterns); 21st.dev, [Cmd-K, recents and actions](https://21st.dev/blog/react-command-palette-components) | Label groups (records, actions, navigation); an empty palette shows recents instead of nothing; arrows move a highlight while focus stays in the field (`aria-activedescendant`); Escape closes and returns focus. | Blank query: Recent, Actions, latest Sessions, Scopes. Typed query: one labeled group per kind, groups ordered by their best hit. Focus returns to the element that had it. |
| Linear, [keyboard shortcuts help](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help) and the Linear command menu | Cmd+K reaches every action and destination; the menu teaches shortcuts. | Actions, destinations (sessions, workspaces, settings pages), and settings (theme, model) share one list. |
| Raycast manual, [Navigation](https://manual.raycast.com/navigation) | Backspace in an empty search goes back one screen. | Nested pages ("Switch model ›", "Change theme ›", "Open workspace ›", a workspace's sessions) push onto a stack; Backspace in an empty field or Escape pops it; Escape on the top level closes. |
| cmdk, [README (pages)](https://github.com/dip/cmdk) | Nested "pages" are a stack of page ids in component state. | Same model: `pages: PageId[]`, the last entry is shown, a breadcrumb button shows where you are. |
| VS Code, [User interface: Quick Open](https://code.visualstudio.com/docs/getstarted/userinterface) and [tips](https://code.visualstudio.com/docs/getstarted/tips-and-tricks) | Prefix characters switch what Quick Open searches (`>` commands, `@` symbols, `#` workspace symbols, `?` help). | `>` (and `/`) commands, `@` sessions, messages, and workspaces, `#` settings pages and themes, `?` lists the scopes. A badge in the field shows the active scope. |
| Open WebUI, [History and search](https://docs.openwebui.com/features/chat-conversations/chat-features/history-search/) | Cmd+K searches chat titles and message text and jumps to the conversation. | Titles rank locally; message text goes to the Host session search after a 200 ms pause and lists one hit per session under Messages. Choosing a hit opens the session and marks the match. |
| W3C APG, [Combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) and [Listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) | DOM focus stays on the combobox; `aria-activedescendant` names the active option; scripts must scroll it into view. | `input[role=combobox][aria-expanded=true][aria-controls][aria-activedescendant]` over `role=listbox` with `role=group` sections labeled by their headings; the active option is scrolled into view; a polite live region announces the result count. |
| kentcdodds, [match-sorter](https://github.com/kentcdodds/match-sorter) | Deterministic ranks: equal, starts with, word starts with, contains, acronym, fuzzy. | Ranking uses match-sorter per whitespace-separated term (all terms must match). |
| FloorLamp/allos, [issue 3423](https://github.com/FloorLamp/allos/issues/3423); MDN, [VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) | On phones the palette should be a full-screen search surface with a visible close control, touch-sized rows, and no key hints. | Below 640 px wide the dialog fills the screen, rows are 48 px, the input uses 16 px text (no iOS zoom), the footer key hints are hidden, and a Close button sits beside the field. |

## Library choice

The `dsh-model-switcher` package in this repository ([its design notes](../../dsh-model-switcher/docs/design.md) compare cmdk, React Aria, Ariakit, Headless UI, fuse.js, and uFuzzy) settled on a hand-written WAI-ARIA combobox plus `match-sorter` 8.3.0, with the Web client's `--dsw-*` tokens for color and the same bottom-sheet breakpoint idea. This menu uses the same pieces for the same reasons:

- `cmdk`, Radix, Ariakit, and React Aria would each add a second React component library to a bundle that the dsh shell loads next to its own primitives; the menu needs one field and one list, which the APG pattern covers in about 400 lines.
- `match-sorter` gives ranks that are easy to explain and test, is small, and is bundled into `lib/client.js` (no runtime dependency).
- Code is copied, not shared: the two packages do not depend on each other.

## Ranking

Score per entry = sum over query terms of `rank × 8 − keyIndex` (title, then keywords, then detail), plus up to 6 for a recent use and 1 for a running session. Keywords are capped at "word starts with" and detail at "contains", so a keyword or description hit never beats a title that starts with the query, and recency (at most 7) never beats a better rank (8). Groups are ordered by their best entry, each shows at most `groupLimit` rows with a "N more" line. Message hits keep the Host's order in a last Messages section.

Recents are entry ids (`session:<id>`, `command:<name>`, `settings:<id>`, ...) in `localStorage` (`dsh-command-menu:recents`, 40 kept), shared across tabs through the `storage` event. No titles, queries, or message text are stored.

## Keyboard map

| Key | Action |
|---|---|
| `Mod+K` (configurable) | Open or close, from anywhere |
| `↑` `↓`, `Ctrl+P` `Ctrl+N` | Previous or next row (wraps) |
| `PageUp` `PageDown`, `Mod+Home` `Mod+End` | Jump |
| `Enter` | Run the row, or open its page |
| `Backspace` in an empty field | Back one page |
| `Esc` | Back one page, then close |
| `Tab` | Stays in the field (the dialog has one stop) |
| `>` `/` `@` `#` `?` as the first character | Narrow to a scope |

The global listener ignores a keydown that another handler already took (`defaultPrevented`), a key held down, and input-method composition, and it skips targets inside `[data-command-menu-ignore]`. The dsh Web client binds no `Mod+K` today (the composer keymap handles Enter, arrows, Tab, Escape, Space, and paste only; the fork's Machines plugin uses `Alt` chords). `@hytime/dsh-client-ui-shortcuts` binds `Meta+Alt+Shift` chords in a capture-phase listener, so the two coexist; if a user binds `Mod+K` there, that plugin prevents the default first and this menu stays closed.

## Seams

All from published `@deepseek-ai/*` client services, read through `ctx.get` so a missing one hides its rows:

| Need | Seam |
|---|---|
| Mount | `shell.overlay` list slot (frame-wide layer from `dsh-client-ui-layout`), plus a button in `sidebar.footer.action` (`dsh-client-ui-sidebar`). The dialog itself is portaled to `document.body` with `role=dialog aria-modal=true`. |
| Sessions and current session | `ctx.sessions.list` (Host list order; the current session is the one the main view retains, `retainedBy.mainView`); archived ids from `ctx.workspaces.list`; blank and subagent sessions hidden. |
| Open a session, new session, workspaces, fork | `ctx.uiWorkspace.openSession / startSession(workspaceId?) / openWorkspace / forkSession`. |
| Message text | `ctx.sessions.search(query, signal)` (Host session-query index; returns `sessionId` and a snippet, at most 20). When the deployment keeps content search off (`session-query-sqlite` `openAt: never`, the Web profile default) the menu says so and still matches titles. |
| Scroll to the match | No public "reveal message" seam exists (search results carry no event sequence number, and the chat exposes no scroll API). The menu opens the session, waits up to 4 s for the text in `[data-conversation-scroll]`, scrolls it into view, and highlights it for 2.4 s; if the match is in history that is not loaded yet it opens the session and says so. |
| Slash commands | `ctx.remote.commands.list(sessionId)` for the current session (Host catalog, same list as the `/` menu's host rows). Running one writes `/name` into that session's composer (`ctx.conversation.input.for(scope).setDraft`) and calls `submit()`, the same path as typing it; a command with an input hint is left as `/name ` in the focused composer. Client-only contributions registered with `ctx.commandUi.register` are not listed: `ctx.commandUi` has no public list. |
| Models | `ctx.modelDirectories.directoryFor(sessionId)`: the same per-session directory as the composer model control and `/model`, so a switch shows up there at once. |
| Settings pages | `settings.section` slot entries (id, label, order). The settings dialog keeps its open state and active page in component state with no service, so the menu clicks the sidebar settings trigger (the button holding the `settings.trigger` slot) and then the page's nav button. |
| Theme | `ctx.theme.getTheme / setTheme`, `theme/change`. |
| Sidebars | `ctx.layout.toggleSidebar()`, `ctx.sidebarRight.toggleExpanded()` when the right sidebar plugin is loaded. |
| Stop, focus composer | The current binding's `session.cancel()`; `ctx.conversation.input.for(scope).focus()`. |
| Recent files | Not included: dsh has no public list of recently opened or edited files; the composer's `@` mention remains the way to reach files. |

## Out of scope

- Running client-only `/` contributions (no public list on `ctx.commandUi`).
- Per-command keyboard shortcuts and a shortcut editor (that is what shortcut plugins are for).
- Server-side ranking of titles; titles are ranked in the browser from the session list the client already holds.
