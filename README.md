# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Each package installs into a stock dsh profile with `dsh plugin --profile <name> add <package>` and builds against the published `@deepseek-ai/*` packages.

| Package | What it does |
|---|---|
| [`dsh-session-retry`](packages/dsh-session-retry/README.md) | Retries a session automatically after a transient failure, with growing backoff, a live retry block in the chat, and an extension point for your own retry conditions. |
| [`dsh-user-shell`](packages/dsh-user-shell/README.md) | `!cmd` and `!!cmd` in the Web composer: shell commands you run yourself in the session workspace, with live output, cancel, and a browser password prompt for sudo; `!` results reach the agent with your next message. |
| [`dsh-hunk-review`](packages/dsh-hunk-review/README.md) | Review the agent's file edits per turn, hunk by hunk, in a right-sidebar tab: keep or revert each hunk, file, or the whole turn (`j`/`k`/`y`/`n`), with conflict detection and a note to the agent about what you reverted. |
| [`dsh-model-switcher`](packages/dsh-model-switcher/README.md) | A richer composer model picker: a searchable provider select (logos, model counts, key status) above a fuzzy, keyboard-first model list grouped by provider, with favorites, recents, context/vision/reasoning badges, the effort control, and a bottom sheet on phones. |

## Working in this repository

```sh
pnpm install
pnpm run check      # typecheck, tests, and build for every package
pnpm run pack       # tarballs in .artifacts/
```

Requires Node.js `^22.19 || >=24` and pnpm 10.

## License

MIT
