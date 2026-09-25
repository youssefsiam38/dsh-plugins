/**
 * Shared vocabulary of `dsh-user-shell`: run modes, outcomes, the live event
 * stream between the Host and the browser, and the model-visible message
 * source. Types only.
 * @module dsh-user-shell/types
 */

/** `context` (`!cmd`) adds the result to the model's context; `quiet` (`!!cmd`) does not. */
export type UserShellMode = 'context' | 'quiet'

/** How a run ended. */
export type UserShellStatus =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly message: string }

/** Source of the `user/message` a `!` run injects into the model's context. */
export interface UserShellMessageSource {
  readonly kind: 'user-shell'
  /** Pairing id of the run's `command/run` / `command/done` record. */
  readonly commandId: string
  /** The command as the user typed it. */
  readonly command: string
  /** Exit code, or null when the process did not exit normally. */
  readonly exitCode: number | null
  /** Outcome kind. */
  readonly status: UserShellStatus['kind']
}

/** One pending sudo password request. */
export interface UserShellAskpass {
  /** Single-use request id minted by the askpass helper. */
  readonly requestId: string
  /** The prompt sudo passed to the helper. */
  readonly prompt: string
}

/** Live view of one running command, as the browser receives it. */
export interface UserShellRunView {
  readonly commandId: string
  readonly sessionId: string
  readonly command: string
  readonly mode: UserShellMode
  /** Epoch milliseconds. */
  readonly startedAt: number
  /**
   * Whether a browser tab started the run through the run route; only that tab
   * may answer its password prompts. Runs started with `/sh` or `/shq` are
   * unclaimed, and any authenticated tab may answer them.
   */
  readonly claimed: boolean
  /** Most recent output (a bounded tail). */
  readonly output: string
  /** Whether older output was dropped from `output`. */
  readonly outputTruncated: boolean
  /** The pending password request, when sudo is asking. */
  readonly askpass?: UserShellAskpass
}

/** Frames of `GET /api/user-shell/events` (one JSON object per server-sent event). */
export type UserShellEvent =
  | { readonly type: 'snapshot'; readonly runs: readonly UserShellRunView[]; readonly quiet: boolean }
  | { readonly type: 'start'; readonly run: UserShellRunView }
  | { readonly type: 'output'; readonly commandId: string; readonly text: string }
  | { readonly type: 'askpass'; readonly commandId: string; readonly askpass: UserShellAskpass }
  | { readonly type: 'askpass-closed'; readonly commandId: string; readonly requestId: string }
  | { readonly type: 'end'; readonly commandId: string; readonly status: UserShellStatus; readonly durationMs: number }

/** Body of `POST /api/user-shell/run`. */
export interface UserShellRunRequest {
  readonly sessionId: string
  readonly command: string
  readonly mode: UserShellMode
  /** Random token of the browser tab; only that tab may answer the run's password prompts. */
  readonly owner: string
}
