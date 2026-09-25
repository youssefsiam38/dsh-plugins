# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Each package installs into a stock dsh profile with `dsh plugin --profile <name> add <package>` and builds against the published `@deepseek-ai/*` packages.

| Package | What it does |
|---|---|
| [`dsh-session-retry`](packages/dsh-session-retry/README.md) | Retries a session automatically after a transient failure, with growing backoff, a live retry block in the chat, and an extension point for your own retry conditions. |
| [`dsh-user-shell`](packages/dsh-user-shell/README.md) | `!cmd` and `!!cmd` in the Web composer: shell commands you run yourself in the session workspace, with live output, cancel, and a browser password prompt for sudo; `!` results reach the agent with your next message. |
| [`dsh-hunk-review`](packages/dsh-hunk-review/README.md) | Review the agent's file edits per turn, hunk by hunk, in a right-sidebar tab: keep or revert each hunk, file, or the whole turn (`j`/`k`/`y`/`n`), with conflict detection and a note to the agent about what you reverted. |
| [`dsh-model-switcher`](packages/dsh-model-switcher/README.md) | A richer composer model picker: a searchable provider select (logos, model counts, key status) above a fuzzy, keyboard-first model list grouped by provider, with favorites, recents, context/vision/reasoning badges, the effort control, and a bottom sheet on phones. Other plugins can open it as a picker. |
| [`dsh-command-menu`](packages/dsh-command-menu/README.md) | Cmd/Ctrl+K command menu: search sessions by title and message text, run slash commands, open settings pages and workspaces, switch the session's model, and run app actions, with recents, nested pages, and `>` `@` `#` scopes. |
| [`dsh-model-compare`](packages/dsh-model-compare/README.md) | Send one prompt to 2–4 models side by side from the current session, with time to first token, total time, tokens, and cost per model, then continue with the answer you pick. Comparison lanes run without tools by default. Uses the `dsh-model-switcher` popover to pick models when it is installed. |

## Install

Each plugin is an npm package that installs into a dsh profile. For the Web UI:

```sh
dsh plugin --profile web add dsh-session-retry
dsh plugin --profile web add dsh-user-shell
dsh plugin --profile web add dsh-hunk-review
dsh plugin --profile web add dsh-model-switcher
dsh plugin --profile web add dsh-command-menu
dsh plugin --profile web add dsh-model-compare
```

Remove one with `dsh plugin --profile web remove <name>`, or manage them on the Plugins page. The plugins need dsh `>=0.1.7-rc.1` and Node.js `^22.19 || >=24`; each README lists its own compatibility notes.

## Working in this repository

```sh
pnpm install
pnpm run check      # typecheck, tests, and build for every package
pnpm run pack       # tarballs in .artifacts/
```

Requires Node.js `^22.19 || >=24` and pnpm 10. Each package also has a browser test against a real dsh Web server (`pnpm --filter <name> run test:e2e`), which runs `@deepseek-ai/dsh` from npm by default; see the package README.

See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
