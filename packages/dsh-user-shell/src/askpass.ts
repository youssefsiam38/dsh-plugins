/**
 * The per-run shell prelude and its marker protocol.
 *
 * Every run executes `/bin/sh -c PRELUDE dsh-user-shell <command> <nonce>
 * <shell> <askpass>` on the target (the server or the session's machine). The
 * prelude creates a private 0700 directory, announces it with a marker line on
 * its own stderr, optionally materializes a `sudo` wrapper (real sudo with
 * `-A`) and an askpass helper there, runs the command with the user's shell
 * (stdin `/dev/null`, stderr merged into stdout), and on exit runs `sudo -k`
 * and removes the directory.
 *
 * When sudo asks for a password the helper creates a FIFO `answer.<pid>` in
 * that directory, writes one marker line `\x1eDSH-USER-SHELL askpass <nonce>
 * <pid> <base64 prompt>` to the prelude's stderr (through
 * `/proc/<prelude pid>/fd/9`, a copy of the prelude's original stderr, or,
 * where that cannot be opened (no `/proc`, or a socket), its own stderr,
 * which sudo passes through and the prelude merges into stdout), and
 * blocks reading the FIFO. The Host strips marker lines from the output and
 * answers by running {@link ANSWER_SCRIPT} on the same target with the answer
 * on stdin: `P<password>` hands the password to sudo, anything else makes the
 * helper exit 1 so sudo fails.
 * @module dsh-user-shell/askpass
 */

/** First bytes of every marker line (record separator + tag). */
export const MARKER_PREFIX = '\u001eDSH-USER-SHELL '

/** Exit status of the prelude when it cannot set up its private directory. */
export const SETUP_FAILED = 125

/** The prelude, run as `/bin/sh -c PRELUDE dsh-user-shell <command> <nonce> <shell> <askpass 1|0>`. */
export const PRELUDE = String.raw`cmd=$1; nonce=$2; shell=$3; askpass=$4
umask 077
exec 9>&2
if [ -z "$shell" ]; then shell=\${SHELL:-/bin/sh}; fi
[ -x "$shell" ] || shell=/bin/sh
d=$(mktemp -d "\${TMPDIR:-/tmp}/dsh-user-shell.XXXXXXXX") || { echo "dsh-user-shell: cannot create a private temporary directory" >&2; exit 125; }
printf '\036DSH-USER-SHELL dir %s %s\n' "$nonce" "$d" >&2
real_sudo=
cleanup() {
  if [ -n "$real_sudo" ]; then "$real_sudo" -k </dev/null >/dev/null 2>&1; fi
  rm -rf "$d"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$askpass" = 1 ]; then
  real_sudo=$(command -v sudo 2>/dev/null) || real_sudo=
  case $real_sudo in /*) ;; *) real_sudo= ;; esac
  case $real_sudo in *"'"*) real_sudo= ;; esac
fi
if [ -n "$real_sudo" ]; then
  mkdir "$d/bin" || exit 125
  printf '#!/bin/sh\nexec '"'"'%s'"'"' -A "$@"\n' "$real_sudo" > "$d/bin/sudo" || exit 125
  {
    printf '#!/bin/sh\nd='"'"'%s'"'"'; n='"'"'%s'"'"'; p='"'"'%s'"'"'\n' "$d" "$nonce" "$$"
    cat <<'HELPER'
f="$d/answer.$$"
mkfifo -m 600 "$f" || exit 1
prompt=$(printf '%s' "\${1:-Password:}" | base64 | tr -d '\n')
m=$(printf '\036DSH-USER-SHELL askpass %s %s %s' "$n" "$$" "$prompt")
{ printf '%s\n' "$m" > "/proc/$p/fd/9"; } 2>/dev/null || printf '%s\n' "$m" >&2
IFS= read -r answer < "$f"
rm -f "$f"
case $answer in
  P*) printf '%s\n' "\${answer#P}" ;;
  *) exit 1 ;;
esac
HELPER
  } > "$d/askpass" || exit 125
  chmod 700 "$d/bin/sudo" "$d/askpass" || exit 125
  SUDO_ASKPASS="$d/askpass"; export SUDO_ASKPASS
  PATH="$d/bin:$PATH"; export PATH
fi
"$shell" -c "$cmd" </dev/null 2>&1
exit $?
`.replaceAll('\\$', '$')

/**
 * Writes stdin to the helper's FIFO: `/bin/sh -c ANSWER_SCRIPT sh <fifo>`.
 * It refuses anything that is not an existing FIFO, so an answer is never written to a regular file.
 */
export const ANSWER_SCRIPT = '[ -p "$1" ] || exit 3; exec cat > "$1"'

/** Removes a run directory left behind by a killed prelude: `/bin/sh -c CLEANUP_SCRIPT sh <dir>`. */
export const CLEANUP_SCRIPT = 'case $1 in */dsh-user-shell.*) ;; *) exit 3 ;; esac; s=$(command -v sudo 2>/dev/null) && "$s" -k </dev/null >/dev/null 2>&1; rm -rf "$1"'

/** One marker the prelude or helper wrote. */
export type Marker =
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'askpass'; readonly requestId: string; readonly prompt: string }

function decodeBase64(text: string): string {
  try {
    const binary = atob(text)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch (error: unknown) {
    // An undecodable prompt is shown as a generic one.
    void error
    return ''
  }
}

function parseMarker(line: string, nonce: string): Marker | undefined {
  const [kind, markerNonce, first, second] = line.slice(MARKER_PREFIX.length).split(' ')
  if (markerNonce !== nonce) return undefined
  if (kind === 'dir' && first !== undefined && first.startsWith('/')) return { kind: 'dir', path: line.slice(MARKER_PREFIX.length + 'dir '.length + nonce.length + 1) }
  if (kind === 'askpass' && first !== undefined && /^\d+$/.test(first)) {
    return { kind: 'askpass', requestId: first, prompt: decodeBase64(second ?? '').trim() }
  }
  return undefined
}

/**
 * Splits one output stream into display text and marker lines of this run.
 * Text without a marker start passes through immediately, including partial
 * lines; a partial line holding a marker start waits for its newline.
 */
export class MarkerParser {
  private pending = ''

  /**
   * @param nonce - this run's nonce; markers with another nonce stay ordinary text.
   */
  constructor(private readonly nonce: string) {}

  /**
   * Feed decoded text.
   * @param chunk - next text of the stream.
   * @returns text to display and markers found.
   */
  feed(chunk: string): { text: string; markers: Marker[] } {
    const input = this.pending + chunk
    this.pending = ''
    let text = ''
    const markers: Marker[] = []
    let offset = 0
    while (offset < input.length) {
      const start = input.indexOf('\u001e', offset)
      if (start < 0) {
        text += input.slice(offset)
        break
      }
      text += input.slice(offset, start)
      const end = input.indexOf('\n', start)
      if (end < 0) {
        this.pending = input.slice(start)
        break
      }
      const line = input.slice(start, end)
      const marker = line.startsWith(MARKER_PREFIX) ? parseMarker(line, this.nonce) : undefined
      if (marker === undefined) text += input.slice(start, end + 1)
      else markers.push(marker)
      offset = end + 1
    }
    return { text, markers }
  }

  /**
   * End of stream: a held partial line is ordinary text.
   * @returns the held text.
   */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest
  }
}
