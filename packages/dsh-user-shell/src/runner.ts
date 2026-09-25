/**
 * One shell run on the session's execution world through `ctx.subprocess`:
 * spawns the prelude, decodes and de-markers output, enforces the timeout and
 * cancellation (the provider terminates the whole managed process range,
 * SIGTERM then SIGKILL after the grace period), and answers password requests
 * through the helper FIFO.
 * @module dsh-user-shell/runner
 */

import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ANSWER_SCRIPT, CLEANUP_SCRIPT, MarkerParser, PRELUDE, SETUP_FAILED } from './askpass.ts'
import type { Marker } from './askpass.ts'
import type { UserShellAskpass, UserShellStatus } from './types.ts'

/** The part of `ctx.subprocess` a run uses. */
export type Spawner = Pick<SubprocessRuntime, 'spawn'>

/** Settings of one run. */
export interface ShellRunOptions {
  /** Absolute working directory; the execution service decides where it runs. */
  readonly cwd: string
  readonly command: string
  /** Shell path; empty uses `$SHELL` on the target, then `/bin/sh`. */
  readonly shell: string
  /** Materialize the sudo wrapper and askpass helper. */
  readonly askpass: boolean
  readonly timeoutMs: number
  /** SIGTERM-to-SIGKILL grace of the provider's termination. */
  readonly killGraceMs: number
  /** Bytes of complete output kept in memory for the spill file. */
  readonly captureBytes: number
  /** Extra environment for the command. */
  readonly env: Readonly<Record<string, string>>
}

/** Callbacks of one run. */
export interface ShellRunEvents {
  /** Display text, in arrival order, with marker lines removed. */
  output(text: string): void
  /** sudo is asking for a password. */
  askpass(request: UserShellAskpass): void
  /** A password request ended (answered, cancelled, timed out, or the run ended). */
  askpassClosed(requestId: string): void
}

/** Final facts of one run. */
export interface ShellRunResult {
  readonly status: UserShellStatus
  readonly durationMs: number
  /** Complete output up to `captureBytes`. */
  readonly output: string
  /** Whether output beyond `captureBytes` was dropped from `output`. */
  readonly captureTruncated: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A single process run; construct, then await {@link ShellRun.done}. */
export class ShellRun {
  /** Resolves when the process range has ended and output is drained. */
  readonly done: Promise<ShellRunResult>
  private readonly abort = new AbortController()
  private reason: 'cancelled' | 'timeout' | undefined
  private readonly nonce = randomBytes(12).toString('hex')
  private readonly pendingAskpass = new Set<string>()
  private dir: string | undefined
  private capture = ''
  private captured = 0
  private captureTruncated = false
  private readonly startedAt: number

  /**
   * @param spawner - `ctx.subprocess`.
   * @param options - run settings.
   * @param events - output and askpass callbacks.
   * @param now - clock.
   */
  constructor(
    private readonly spawner: Spawner,
    private readonly options: ShellRunOptions,
    private readonly events: ShellRunEvents,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now()
    this.done = this.run()
  }

  /** Cancel: terminate the process range. */
  cancel(): void {
    if (this.reason === undefined) this.reason = 'cancelled'
    this.abort.abort()
  }

  /**
   * Whether a password request is pending.
   * @param requestId - helper request id.
   * @returns true while unanswered.
   */
  hasAskpass(requestId: string): boolean {
    return this.pendingAskpass.has(requestId)
  }

  /**
   * Answer one password request: a password hands it to sudo, `undefined` refuses it.
   * @param requestId - helper request id.
   * @param password - the password, or undefined to refuse.
   * @returns whether the helper received the answer.
   */
  async answer(requestId: string, password: string | undefined): Promise<boolean> {
    if (!this.pendingAskpass.delete(requestId) || this.dir === undefined) return false
    this.events.askpassClosed(requestId)
    const input = password === undefined ? 'C\n' : `P${password}\n`
    const timeout = AbortSignal.timeout(10_000)
    try {
      const handle = this.spawner.spawn({
        argv: ['/bin/sh', '-c', ANSWER_SCRIPT, 'sh', `${this.dir}/answer.${requestId}`],
        cwd: this.options.cwd,
        stdio: { stdin: { data: input }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
        graceMs: 1000,
        signal: timeout,
      })
      const outcome = await handle.done
      return outcome.exitCode === 0
    } catch (error: unknown) {
      // The helper is gone or the target is unreachable; sudo fails without an answer.
      void error
      return false
    }
  }

  private async run(): Promise<ShellRunResult> {
    const timer = setTimeout(() => {
      this.reason = 'timeout'
      this.abort.abort()
    }, this.options.timeoutMs)
    let handle: SubprocessHandle
    try {
      handle = this.spawner.spawn({
        argv: ['/bin/sh', '-c', PRELUDE, 'dsh-user-shell', this.options.command, this.nonce, this.options.shell, this.options.askpass ? '1' : '0'],
        cwd: this.options.cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.options.killGraceMs,
        signal: this.abort.signal,
        env: { ...this.options.env },
      })
    } catch (error: unknown) {
      clearTimeout(timer)
      return this.finish({ kind: 'failed', message: describe(error) })
    }
    const drained = Promise.all([this.pump(handle.stdout), this.pump(handle.stderr)])
    let status: UserShellStatus
    try {
      const outcome = await handle.done
      await drained
      status = this.reason !== undefined ? { kind: this.reason }
        : outcome.exitCode === SETUP_FAILED && this.dir === undefined ? { kind: 'failed', message: 'could not create a private temporary directory' }
          : outcome.exitCode !== null ? { kind: 'exited', exitCode: outcome.exitCode }
            : { kind: 'signal', signal: outcome.signal ?? 'unknown' }
    } catch (error: unknown) {
      status = this.reason !== undefined ? { kind: this.reason } : { kind: 'failed', message: describe(error) }
    } finally {
      clearTimeout(timer)
    }
    for (const requestId of this.pendingAskpass) this.events.askpassClosed(requestId)
    this.pendingAskpass.clear()
    if (status.kind !== 'exited' && this.dir !== undefined) await this.cleanup(this.dir)
    return this.finish(status)
  }

  private finish(status: UserShellStatus): ShellRunResult {
    return { status, durationMs: this.now() - this.startedAt, output: this.capture, captureTruncated: this.captureTruncated }
  }

  /** A killed prelude cannot run its own cleanup: remove the directory and cached sudo credential from here. */
  private async cleanup(dir: string): Promise<void> {
    try {
      const handle = this.spawner.spawn({
        argv: ['/bin/sh', '-c', CLEANUP_SCRIPT, 'sh', dir],
        cwd: this.options.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
        graceMs: 1000,
        signal: AbortSignal.timeout(10_000),
      })
      await handle.done
    } catch (error: unknown) {
      // Best effort: the directory holds only the helper scripts and an empty FIFO.
      void error
    }
  }

  private async pump(stream: Readable | undefined): Promise<void> {
    if (stream === undefined) return
    const decoder = new StringDecoder('utf8')
    const parser = new MarkerParser(this.nonce)
    const deliver = (text: string, markers: readonly Marker[]): void => {
      for (const marker of markers) this.onMarker(marker)
      if (text === '') return
      this.append(text)
      this.events.output(text)
    }
    try {
      for await (const chunk of stream) {
        const decoded = decoder.write(chunk as Buffer)
        const { text, markers } = parser.feed(decoded)
        deliver(text, markers)
      }
    } catch (error: unknown) {
      // A stream torn down by termination ends the output; the outcome reports why.
      void error
    }
    const { text, markers } = parser.feed(decoder.end())
    deliver(text + parser.flush(), markers)
  }

  private append(text: string): void {
    const room = this.options.captureBytes - this.captured
    const size = Buffer.byteLength(text)
    if (size <= room) {
      this.capture += text
      this.captured += size
      return
    }
    this.captureTruncated = true
    if (room <= 0) return
    const kept = Buffer.from(text).subarray(0, room).toString('utf8').replace(/\uFFFD$/, '')
    this.capture += kept
    this.captured += Buffer.byteLength(kept)
  }

  private onMarker(marker: Marker): void {
    if (marker.kind === 'dir') {
      this.dir = marker.path
      return
    }
    if (this.reason !== undefined || this.pendingAskpass.has(marker.requestId)) return
    this.pendingAskpass.add(marker.requestId)
    this.events.askpass({ requestId: marker.requestId, prompt: marker.prompt })
  }
}
