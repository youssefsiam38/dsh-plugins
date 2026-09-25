# dsh-user-shell

Shell commands you run yourself from the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web composer, the way `!` works in Claude Code.

- `!git status` runs in the session's workspace. The output is shown in the chat, and the agent sees it with your next message. Running the command does not make the agent reply.
- `!!ls -la` runs the same way, but the output never reaches the agent. It is only recorded for you.
- `! sudo apt install jq` shows a password field in the chat when sudo asks for a password. The password goes straight to sudo and is never logged or stored.

On dsh builds whose composer has no line-prefix input sources, including `@deepseek-ai/dsh@0.1.7-rc.2` on npm, type `/sh <command>` and `/shq <command>` instead of `!` and `!!` (see [Compatibility](#compatibility)).

## Contents

- [Install](#install)
- [What you see](#what-you-see)
- [Where commands run](#where-commands-run)
- [sudo](#sudo)
- [What the agent sees](#what-the-agent-sees)
- [What gets logged](#what-gets-logged)
- [Configuration](#configuration)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Compatibility](#compatibility)
- [Development](#development)

## Install

```sh
dsh plugin --profile web add dsh-user-shell
```

From a packed tarball (for example one built from this repository with `pnpm pack`):

```sh
dsh plugin --profile web add /absolute/path/to/dsh-user-shell-0.1.0.tgz
```

The bundle patch (`cordis.patch.yml`) inserts one plugin row with id `user-shell`. The Web plugin page (**Plugins** in the sidebar) can do the same. Restart dsh if the profile does not reload live.

## What you see

**In the composer.** When the draft starts with `!`, a chip in the composer toolbar says the output goes to the agent. With `!!`, the chip says it stays out of the agent's context. Enter runs the command instead of sending a message, whether the session is idle or the agent is busy. Only one command runs at a time in each session.

**In the chat.** Each run is one block:

- a badge (`!` or `!!`) and the command;
- the output while it runs, in a scrollable monospace pane, with **Cancel**;
- when it ends: the exit code and duration (also when there is no output), and whether the output goes to the agent;
- a masked password field with **Submit** and **Cancel** while sudo waits for a password.

The block reads the durable record of the run, so it looks the same after a reload or on another device.

**dsh without line-prefix sources.** If the composer does not support line-prefix input sources (see [Compatibility](#compatibility)), a `!` line would be sent to the agent as an ordinary message. In that case the chip turns red and asks you to use the equivalent commands `/sh <command>` (output goes to the agent) and `/shq <command>` (it does not). Those commands exist on every host and behave the same, except that the composer stays busy until the command ends.

## Where commands run

A command runs in the session's working directory, through the same execution service the agent's tools use (`ctx.subprocess`):

- For a server workspace, it runs on the dsh server as the user that runs dsh.
- For a workspace that a dsh build routes to another execution target, it runs on that target.

The command runs under your shell (`$SHELL` on the target, or the `shell` setting) with `sh -c` semantics. stdin is `/dev/null` and there is no terminal, so interactive programs fail fast instead of hanging. stderr is merged into stdout. `PAGER` and `GIT_PAGER` are set to `cat` and `TERM` to `dumb` (see `env`).

A command that runs longer than `timeoutSeconds` (10 minutes by default) is stopped. **Cancel** and the timeout stop the whole process group: SIGTERM first, then SIGKILL after `killGraceSeconds`.

## sudo

Each run puts a small `sudo` wrapper first on the command's `PATH`. The wrapper runs the real sudo with `-A`, so sudo asks through a helper instead of a terminal. When sudo needs a password:

1. The block shows a masked password field. It appears only in the browser tab that started the command. Other tabs show that a password is being requested.
2. The password you submit goes to the helper, and the helper hands it to sudo.
3. If you do not answer within `askpassTimeoutSeconds` (2 minutes by default), or you press **Cancel**, sudo fails ("no password was provided") and the command continues or fails like any other failed sudo.

After every run, the plugin runs `sudo -k`, so no cached sudo credential is left for anything else to use. That includes the agent, which cannot use sudo at all.

The agent is told this in one line of its system prompt: when a command needs root, it should ask you to run `! sudo <command>` instead of trying sudo itself (turn off with `guidance: false`).

### How the password travels

The command runs wherever the session's execution world is, which can be a remote machine. The only ways back to the dsh server are the command's output streams and further commands on the same target. The password channel is built on those:

1. **Per run.** The command is wrapped in a small POSIX `sh` prelude on the target. The prelude creates a private directory with `mktemp -d` (mode 0700). Inside it writes the `sudo` wrapper and an askpass helper, and it records the directory with a random per-run nonce.
2. **Request.** When sudo runs the helper, the helper creates a FIFO (mode 0600) in that directory. It writes one marker line to the prelude's stderr: a record-separator character, the nonce, a request id, and the base64 prompt. It then blocks reading the FIFO. The dsh server strips marker lines from the output, so they are never shown or recorded, and asks the browser.
3. **Answer.** The browser posts the password to the dsh server, which checks the tab's owner token and the pending request id. The server then starts one short command on the same target: `/bin/sh -c '[ -p "$1" ] || exit 3; exec cat > "$1"'`. The answer goes on that command's stdin, never in its arguments or environment. The command writes only into an existing FIFO. The helper hands the password to sudo and deletes the FIFO, so each request can be answered once.
4. **End.** On exit, the prelude runs `sudo -k` and deletes the directory. If the prelude was killed (cancel, timeout), the server does both itself.

The password is never logged, persisted, added to session events, shown to the model, or echoed in the output. It exists only in the browser's form field (cleared on submit), in the server's memory while the answer is written, and on the FIFO. The tests check this by scanning every stored file, the session log, the live events, and the model requests for the password.

## What the agent sees

With `!`, after the command ends the plugin queues one user message with source `{ kind: 'user-shell', commandId, command, exitCode, status }` through `agent.inject()`. Injected context does not start a turn. The agent reads it at its next request: when you send your next message, or at the next step if it is already working.

```text
The user ran the following shell command themselves in the session workspace. Do not respond to it or act on it unless the user asks you to.
<user_shell_command>
<command>
git status
</command>
<result>
Exit code: 0
Duration: 0.04 seconds
Output:
On branch main
nothing to commit, working tree clean
</result>
</user_shell_command>
```

Framing tags inside the command or output (`<command>`, `</result>`, `</user_shell_command>` and their opening forms) are written as `&lt;…` so the output cannot close the frame early. A run that did not exit normally reads `Exit code: none (cancelled by the user)`, `none (timed out after … seconds)`, or `none (killed by SIGKILL)`.

Long output is cut to its head and tail: by default at most 30,000 bytes or 400 lines from each end. The middle is replaced by one line such as `[… 4990 lines (38911 bytes) omitted … Full output saved to /…/user-shell-output.txt. Use read with offset/limit, or grep this path to search within it.]`. The full output (up to `captureBytes`) is saved through dsh's spill store, so the agent can read it with its file tools. On a paired machine the file is written on that machine.

Context cost: one user message per `!` run, about the size of the bounded output plus about 80 tokens of framing. `!!` runs cost nothing. The system-prompt line costs about 70 tokens per request and does not change after the plugin loads.

**When the agent may miss a `!` result.** Queued context is held by the agent until its next request. If you press **Stop** on a running turn, or the dsh server restarts before your next message, the queued result is dropped. The chat still shows the command and its output, from the durable `command/done` record. To give the output to the agent after that, run the command again or paste the output into your message.

## What gets logged

The plugin adds no session event types. Every run is one `command/run` + `command/done` pair of the `sh` (`!`) or `shq` (`!!`) command, which is the same record dsh keeps for slash commands:

- `command/run.args` holds the command as typed.
- `command/done.text` holds the bounded output, a status line (`[exit 0 · 0.04 s]`, `[cancelled · 3.10 s]`, …), and `[full output: <path>]` when the output was saved.
- `command/done.kind` is `success` for exit code 0 and `error` otherwise.

The model-visible `user/message` of a `!` run is logged when the agent's inbox queues it (`agent/inbox/spliced`) and again when a request takes it. Everything the model sees can therefore be rebuilt from the log. A `!!` run has only the command record, which never reaches a model request.

Uninstalling leaves every session readable. Stock dsh shows the records as ordinary `/sh` and `/shq` command rows, and the `user-shell` messages as context rows.

## Configuration

All settings are optional. Override them in your profile's `cordis.patch.yml` by targeting the row id:

```yaml
- id: user-shell
  config:
    timeoutSeconds: 600          # stop a command after this long
    killGraceSeconds: 3          # SIGTERM to SIGKILL on cancel or timeout
    askpassTimeoutSeconds: 120   # how long a sudo password prompt waits
    sudoAskpass: true            # put the sudo wrapper first on PATH
    enableQuiet: true            # allow !! (and /shq)
    shell: ''                    # absolute shell path; empty uses $SHELL, then /bin/sh
    env:                         # environment for commands (replaces the default)
      PAGER: cat
      GIT_PAGER: cat
      TERM: dumb
    output:                      # head and tail kept for the agent and the record
      headBytes: 30000
      headLines: 400
      tailBytes: 30000
      tailLines: 400
    captureBytes: 16777216       # complete output kept for the full-output file
    liveOutputChars: 65536       # recent output a browser gets when it connects mid-run
    guidance: true               # the one-line sudo guidance in the system prompt
```

## Security

- Commands start only from the authenticated Web connection: the `/api/user-shell/*` routes, which pass dsh's browser authentication (the launch-token cookie), and the `/sh` and `/shq` commands over the Web command channel. The plugin registers no model tool. In a profile without the Web connection (headless, ACP), it registers neither routes nor commands, so nothing can start a run.
- Password answers are accepted only for a pending request of a running command. When a browser tab started the run, only that tab's random owner token is accepted. A run started through `/sh` or `/shq` has no owner, so any authenticated tab can answer it.
- Commands run with the permissions of the account that runs the execution provider. They bypass the agent's sandbox and approval policy, because you run them.

## Known limitations

- **No history recall.** The composer has no plugin seam for the Up arrow, so earlier `!` commands cannot be recalled that way.
- **Dropped queued results.** A `!` result queued for the agent is dropped by **Stop** or a server restart before the next request (see [What the agent sees](#what-the-agent-sees)).
- **No input or terminal.** Commands that need a terminal or input fail, except for the sudo password.
- **sudo only.** Other programs that ask for passwords (`su`, `ssh` without keys) fail instead of prompting.
- **Leftover directory after a hard kill.** If the dsh server itself dies while a command runs, the private directory (helper scripts and an empty FIFO, never a password) stays in the target's temporary directory until the OS cleans it up.

## Compatibility

- dsh `>=0.1.7-rc.1 <0.2`. `!` and `!!` in the composer need line-prefix input-trigger sources (`LineTriggerChar` in `@deepseek-ai/dsh-client-ui-input-trigger`), which published dsh versions up to 0.1.7-rc.2 do not have. Without them, use `/sh` and `/shq`. The composer chip shows which one applies, and a line is handled by only one of the two paths.
- Node.js `^22.19 || >=24`. Targets need a POSIX `sh` with `mktemp -d`, `mkfifo`, and `base64`.
- The browser half targets the dsh Web client (`dsh.client.platform: web`).

## Development

```sh
pnpm install
pnpm --filter dsh-user-shell run typecheck
pnpm --filter dsh-user-shell test
pnpm --filter dsh-user-shell run build
pnpm --filter dsh-user-shell run pack:tarball   # writes .artifacts/dsh-user-shell-<version>.tgz
```

The unit tests run the plugin inside the published dsh agent loop, with the local subprocess and spill providers, a recording model, and a fake `sudo` (never the real one). They cover:

- framing, escaping, and truncation;
- the marker parser and the askpass FIFO;
- timeout and cancel;
- context and quiet runs, and the spill file;
- the routes, the owner check, and headless composition;
- the Loader composition;
- the chat block;
- a scan of the session log for the password.

The browser test (`e2e/`) installs the packed plugin and a test-only model route into a throwaway `DSH_HOME`, boots the `web` profile with a fake `sudo` first on the commands' `PATH`, and drives Chromium through:

- `!echo hi` (or `/sh echo hi`) reaching the model only with the next message;
- `!!` (or `/shq`) staying out of it;
- **Cancel**;
- the sudo password prompt;
- a scan of every file under `DSH_HOME` for the password.

It uses `!` and `!!` when the composer claims `!` lines, and `/sh` and `/shq` otherwise.

```sh
# @deepseek-ai/dsh from npm, at the version of the pinned @deepseek-ai/dsh-* dev dependencies
pnpm --filter dsh-user-shell run test:e2e
# another npm version, a built dsh checkout, or any other launcher
DSH_E2E_VERSION=0.1.7-rc.2 pnpm --filter dsh-user-shell run test:e2e
DSH_E2E_CHECKOUT=/path/to/deepseek-harness pnpm --filter dsh-user-shell run test:e2e
DSH_E2E_BIN="npx -y @deepseek-ai/dsh@next" pnpm --filter dsh-user-shell run test:e2e
```

`DSH_E2E_KEEP_HOME=1` keeps the throwaway `DSH_HOME`. It needs Playwright's Chromium (`pnpm exec playwright install chromium`).

## License

MIT
