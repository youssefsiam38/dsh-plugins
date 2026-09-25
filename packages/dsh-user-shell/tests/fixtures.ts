/** Shared test fixtures: a fake `sudo` that asks through `SUDO_ASKPASS`, and temporary PATH directories. */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Password the fake sudo accepts. */
export const FAKE_PASSWORD = 'hunter2 correct horse'

/**
 * A fake `sudo`: `-k` succeeds, `-A` asks `$SUDO_ASKPASS` once and runs the
 * command when the answer matches {@link FAKE_PASSWORD}, and anything else
 * fails like sudo does without a password. It records its invocations in
 * `$FAKE_SUDO_LOG` when set.
 */
export const FAKE_SUDO = `#!/bin/sh
[ -n "$FAKE_SUDO_LOG" ] && printf '%s\\n' "$*" >> "$FAKE_SUDO_LOG"
askpass=0
while [ $# -gt 0 ]; do
  case $1 in
    -k|-K) [ $# -eq 1 ] && exit 0; shift ;;
    -A) askpass=1; shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ "$askpass" != 1 ] || [ -z "$SUDO_ASKPASS" ]; then echo "sudo: a terminal is required to read the password" >&2; exit 1; fi
pw=$("$SUDO_ASKPASS" "[sudo] password for tester: ") || { echo "sudo: no password was provided" >&2; exit 1; }
if [ "$pw" != '${FAKE_PASSWORD}' ]; then echo "sudo: incorrect password attempt" >&2; exit 1; fi
echo "fake-sudo: authenticated"
exec "$@"
`

/**
 * Create a directory holding the fake `sudo`.
 * @returns the directory and its disposer.
 */
export async function fakeSudoDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-user-shell-fake-sudo-'))
  await writeFile(join(dir, 'sudo'), FAKE_SUDO)
  await chmod(join(dir, 'sudo'), 0o755)
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}
