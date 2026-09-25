# dsh-command-menu

A Cmd/Ctrl+K command menu for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web UI, in the style of Linear, Raycast, and VS Code. One keyboard-first search box finds and acts on:

- **sessions** by title, and **message text** through the server's session search; opening a message hit scrolls to the match;
- the current session's **slash commands**;
- **settings pages**, **themes**, and **workspaces**;
- **models**: switch the current session's model;
- **actions**: new session, toggle the sidebars, toggle light and dark, fork the session, stop the running turn, focus the message box.

## Contents

- [Install](#install)
- [Using it](#using-it)
- [What each row does](#what-each-row-does)
- [Configuration](#configuration)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [Compatibility](#compatibility)
- [Development](#development)

## Install

```sh
dsh plugin --profile web add dsh-command-menu
```

From a packed tarball (for example one built from this repository with `pnpm pack`):

```sh
dsh plugin --profile web add /absolute/path/to/dsh-command-menu-0.1.0.tgz
```

The bundle patch (`cordis.patch.yml`) inserts one plugin row with id `command-menu`. Restart dsh if the profile does not reload live.

Message text search needs the server's session search index, which the stock Web profile keeps off. Turn it on with a profile patch:

```yaml
- id: session-query-sqlite
  config:
    path: ':memory:'          # or a file path to keep the index across restarts
    openAt: first-search
```

Without it the menu still matches session titles and says that message search is off.

## Using it

Press **Cmd+K** (macOS) or **Ctrl+K** (Windows, Linux) anywhere, including while typing in the message box. Press it again, or Escape, to close. On a phone, tap the search button at the bottom of the sidebar; the menu fills the screen.

With an empty search box the menu lists **Recent** entries you used, then **Actions**, your latest **Sessions**, and the search **Scopes**. Type to search everything; results are grouped (Sessions, Commands, Settings, Models, Messages, ...) and the group with the best match comes first.

| Key | Action |
|---|---|
| `↑` `↓` (or `Ctrl+P` `Ctrl+N`) | Move |
| `Enter` | Run the highlighted row, or open its list |
| `Backspace` in an empty box | Back one list |
| `Esc` | Back one list, then close |

Start the search with a prefix to narrow it:

| Prefix | Searches |
|---|---|
| `>` or `/` | Slash commands (and actions) |
| `@` | Sessions, message text, and workspaces |
| `#` | Settings pages and themes |
| `?` | Lists these scopes |

Rows ending in `›` open a nested list: **Switch model…**, **Change theme…**, **Open workspace…**, and each workspace (its sessions plus "New session in ..."). The field shows where you are; Backspace in an empty field goes back.

## What each row does

| Row | Effect |
|---|---|
| Session | Opens the session. |
| Message hit | Opens the session, scrolls the matching text into view, and highlights it for a moment. If the match is in older history that is not loaded yet, a notice says to scroll up. |
| `/command` | Runs the command in the current session, exactly as if you typed it in the message box. A command that takes input (such as `/goal <objective>`) is placed in the message box for you to finish. The message box draft is replaced. |
| Settings page | Opens Settings on that page. |
| Theme | Sets the theme preference (Follow system, Light, Dark, or an installed theme). |
| Model | Switches the current session's model; the composer's model control shows the change. |
| Workspace | Opens a list of its sessions and "New session in ...". |

Rows appear only when the part of dsh behind them is loaded: no model or command rows without an open session, no Stop without a running turn, no right-panel toggle without the right sidebar.

## Configuration

A profile patch targeting the `command-menu` row:

```yaml
- id: command-menu
  config:
    hotkeys: [Mod+K, Mod+Shift+P]   # Mod = Cmd on macOS, Ctrl elsewhere
    recentLimit: 5                  # recents on the empty menu, 0 to 20
    groupLimit: 8                   # rows per group while searching, 1 to 50
    messageSearch: true             # search message text through the server
```

| Field | Default | Meaning |
|---|---|---|
| `hotkeys` | `[Mod+K]` | Key combinations that open and close the menu: `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift` joined with `+`, then a letter, digit, `F1`–`F12`, or a named key (`Slash`, `Period`, `Comma`, `Space`, ...). Keys match the physical key, so they work in any keyboard layout. An empty list leaves only the sidebar button. |
| `recentLimit` | `5` | Recently used entries listed when the search box is empty. |
| `groupLimit` | `8` | Rows each group shows while searching; the rest are counted. |
| `messageSearch` | `true` | Also search message text. |

The hotkey yields when another handler already took the key (for example a shortcut plugin bound to the same combination), while an input method is composing, and inside any element marked `data-command-menu-ignore`.

## Privacy

Recently used entries are stored in this browser's `localStorage` (`dsh-command-menu:recents`) as ids only (`session:<id>`, `command:<name>`, ...). Search text, titles, and message snippets are never stored. Message search sends the query to your dsh server's session search, like the sidebar search does.

## Known limitations

- **Client-only slash commands** (added by browser plugins through `commandUi.register`) are not listed; dsh has no public list of them. Host commands, skills, and plugin commands are listed.
- **Opening a settings page** clicks the sidebar Settings button and then the page's tab, because the settings dialog has no public "open page" call. A layout without that button shows a notice.
- **Scroll to match** searches the rendered conversation for the query text. Message search returns no message position, so a match in history that is not loaded yet cannot be revealed.
- **Recent files** are not listed; dsh exposes no list of recently opened files. Use `@` in the message box for files.

## Compatibility

- dsh `>=0.1.7-rc.1 <0.2`, Web profile (`dsh.client.platform: web`).
- Node.js `^22.19 || >=24`.
- Coexists with keyboard-shortcut plugins such as `@hytime/dsh-client-ui-shortcuts` (its default chords use `Meta+Alt+Shift`).

## Development

```sh
pnpm install
pnpm --filter dsh-command-menu run typecheck
pnpm --filter dsh-command-menu test
pnpm --filter dsh-command-menu run build
pnpm --filter dsh-command-menu run pack:tarball   # writes .artifacts/dsh-command-menu-<version>.tgz
```

The unit tests cover ranking, prefixes, grouping, recents, and hotkey matching; the menu's keyboard behavior, nested pages, and ARIA wiring in jsdom; the service adapter against fake dsh services (commands, model switch, settings, message reveal); the client plugin's registrations and global hotkey; and the Host half through a real Cordis Loader.

The browser test (`e2e/`) installs the packed plugin and a test-only model route into a throwaway `DSH_HOME`, boots the `web` profile with message search on, and drives Chromium through the hotkey, a new session, message search and reveal, the nested model page and a model switch, slash commands, a settings page, themes, recents, and the phone-width sheet:

```sh
# @deepseek-ai/dsh from npm, at the version of the pinned @deepseek-ai/dsh-* dev dependencies
pnpm --filter dsh-command-menu run test:e2e
# another npm version, a built dsh checkout, or any other launcher
DSH_E2E_VERSION=0.1.7-rc.2 pnpm --filter dsh-command-menu run test:e2e
DSH_E2E_CHECKOUT=/path/to/deepseek-harness pnpm --filter dsh-command-menu run test:e2e
DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next" pnpm --filter dsh-command-menu run test:e2e
```

`DSH_E2E_KEEP_HOME=1` keeps the throwaway `DSH_HOME`; `DSH_E2E_SCREENSHOT=/path.png` saves a screenshot of the open menu. It needs Playwright's Chromium (`pnpm exec playwright install chromium`).

Design notes and research: [docs/design.md](docs/design.md).

## License

MIT
