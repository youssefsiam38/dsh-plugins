# Contributing

Issues and pull requests are welcome.

## Setup

```sh
pnpm install
pnpm run check      # typecheck, unit tests, and build for every package
```

Requires Node.js `^22.19 || >=24` and pnpm 10.

## Changes

- Each package in `packages/` is published on its own. Keep a change to the packages it needs, and update the package README when behavior or configuration changes.
- Add or update unit tests with every behavior change. For UI changes, also run the package's browser test: `pnpm --filter <name> run test:e2e` (it needs Playwright's Chromium: `pnpm exec playwright install chromium`). By default it runs `@deepseek-ai/dsh` from npm; the package README lists the other options.
- Plugins must work on a stock dsh install from npm. Build against the published `@deepseek-ai/*` packages and declare them as peer dependencies with caret ranges.
- Do not commit credentials, personal paths, or data from real sessions in tests, fixtures, or screenshots.

## Security issues

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
