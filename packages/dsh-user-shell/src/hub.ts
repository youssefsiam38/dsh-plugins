/**
 * Live state of running commands and its `text/event-stream` fan-out. Output
 * is coalesced per run and each run keeps only a bounded tail for snapshots.
 * Nothing here is durable; the session log holds the record.
 * @module dsh-user-shell/hub
 */

import type { UserShellAskpass, UserShellEvent, UserShellMode, UserShellRunView, UserShellStatus } from './types.ts'

interface LiveRun {
  readonly commandId: string
  readonly sessionId: string
  readonly command: string
  readonly mode: UserShellMode
  readonly startedAt: number
  readonly claimed: boolean
  output: string
  outputTruncated: boolean
  askpass: UserShellAskpass | undefined
  /** Output not yet sent to subscribers. */
  unsent: string
}

type Listener = (event: UserShellEvent) => void

/** Fan-out of live run events to event-stream subscribers. */
export class UserShellHub {
  private readonly runs = new Map<string, LiveRun>()
  private readonly listeners = new Set<Listener>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param liveBytes - characters of recent output each run keeps for snapshots.
   * @param quiet - whether `!!` runs are enabled (sent with every snapshot).
   * @param flushMs - output coalescing interval.
   */
  constructor(private readonly liveBytes: number, private readonly quiet: boolean, private readonly flushMs = 50) {}

  /**
   * Subscribe; the listener first receives a snapshot of every running command.
   * @param listener - event callback.
   * @returns unsubscribe.
   */
  subscribe(listener: Listener): () => void {
    this.flush()
    listener({ type: 'snapshot', runs: [...this.runs.values()].map(run => this.view(run)), quiet: this.quiet })
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * A run started.
   * @param run - identity and command.
   * @param run.commandId - pairing id of its command record.
   * @param run.sessionId - session.
   * @param run.command - command text.
   * @param run.mode - context or quiet.
   * @param run.startedAt - epoch milliseconds.
   * @param run.claimed - whether a browser tab owns the run's password prompts.
   */
  start(run: { commandId: string; sessionId: string; command: string; mode: UserShellMode; startedAt: number; claimed: boolean }): void {
    const live: LiveRun = { ...run, output: '', outputTruncated: false, askpass: undefined, unsent: '' }
    this.runs.set(run.commandId, live)
    this.emit({ type: 'start', run: this.view(live) })
  }

  /**
   * Output arrived.
   * @param commandId - run.
   * @param text - display text.
   */
  output(commandId: string, text: string): void {
    const run = this.runs.get(commandId)
    if (run === undefined) return
    run.output += text
    if (run.output.length > this.liveBytes) {
      run.output = run.output.slice(run.output.length - this.liveBytes)
      run.outputTruncated = true
    }
    run.unsent += text
    if (run.unsent.length > this.liveBytes) run.unsent = run.unsent.slice(run.unsent.length - this.liveBytes)
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, this.flushMs)
  }

  /**
   * sudo asks for a password.
   * @param commandId - run.
   * @param askpass - request.
   */
  askpass(commandId: string, askpass: UserShellAskpass): void {
    const run = this.runs.get(commandId)
    if (run === undefined) return
    this.flush()
    run.askpass = askpass
    this.emit({ type: 'askpass', commandId, askpass })
  }

  /**
   * A password request ended.
   * @param commandId - run.
   * @param requestId - request.
   */
  askpassClosed(commandId: string, requestId: string): void {
    const run = this.runs.get(commandId)
    if (run?.askpass?.requestId !== requestId) return
    run.askpass = undefined
    this.emit({ type: 'askpass-closed', commandId, requestId })
  }

  /**
   * A run ended.
   * @param commandId - run.
   * @param status - outcome.
   * @param durationMs - wall time.
   */
  end(commandId: string, status: UserShellStatus, durationMs: number): void {
    this.flush()
    if (!this.runs.delete(commandId)) return
    this.emit({ type: 'end', commandId, status, durationMs })
  }

  /** Drop timers; subscribers are closed by their owners. */
  dispose(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.listeners.clear()
  }

  private flush(): void {
    for (const run of this.runs.values()) {
      if (run.unsent === '') continue
      const text = run.unsent
      run.unsent = ''
      this.emit({ type: 'output', commandId: run.commandId, text })
    }
  }

  private view(run: LiveRun): UserShellRunView {
    return {
      commandId: run.commandId,
      sessionId: run.sessionId,
      command: run.command,
      mode: run.mode,
      startedAt: run.startedAt,
      claimed: run.claimed,
      output: run.output,
      outputTruncated: run.outputTruncated,
      ...run.askpass === undefined ? {} : { askpass: run.askpass },
    }
  }

  private emit(event: UserShellEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error: unknown) {
        // One broken stream must not starve the others; its owner closes it.
        void error
      }
    }
  }
}
