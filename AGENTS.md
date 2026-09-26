# AGENTS.md

Notes for coding agents working in this repository. User-facing documentation is in each package's README; contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## This repository is public

- Never commit personal data: absolute home paths, email addresses, private domains, machine or host names, IPs, tokens, real session ids, or screenshots taken from a private deployment. Take screenshots from a stock `@deepseek-ai/dsh` server.
- Every package must work on stock DeepSeek Harness from npm, with nothing from any private fork. Feature-detect optional seams and degrade (for example `dsh-user-shell` falls back to `/sh` and `/shq` where the `!` line prefix is unavailable).

## Plugin rules

- Add no new durable session event types. A plugin's events cannot be marked ignorable, so uninstalling it would make Sessions that contain them unreadable; record facts through existing events such as `user/message` with a plugin `source`.
- Declare DSH peers as `^<baseline>` ranges, never exact versions; the host disables a plugin whose peer range does not match.
- English and Chinese copy for every client string.
- Commit messages are plain: no AI attribution or co-author trailers.

## Checks and releases

- `pnpm run check` (typecheck, unit tests, build) before pushing to `main`.
- End-to-end tests default to `npx @deepseek-ai/dsh@<pinned devDependency>`; `DSH_E2E_VERSION`, `DSH_E2E_CHECKOUT` and `DSH_E2E_BIN` override the target.
- Bump the package version, pack the tarball into `.artifacts/`, and run `npm publish --dry-run <tarball>`. The maintainer publishes: the npm account uses security keys, so publishing needs `npm publish <tarball> --auth-type=web` in the maintainer's own terminal.
