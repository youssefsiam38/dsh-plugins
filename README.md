# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Each package installs into a stock dsh profile with `dsh plugin --profile <name> add <package>` and builds against the published `@deepseek-ai/*` packages.

| Package | What it does |
|---|---|
| [`dsh-session-retry`](packages/dsh-session-retry/README.md) | Retries a session automatically after a transient failure, with growing backoff, a live retry block in the chat, and an extension point for your own retry conditions. |

## Working in this repository

```sh
pnpm install
pnpm run check      # typecheck, tests, and build for every package
pnpm run pack       # tarballs in .artifacts/
```

Requires Node.js `^22.19 || >=24` and pnpm 10.

## License

MIT
