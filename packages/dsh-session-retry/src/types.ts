/**
 * Public contract of `dsh-session-retry`: the failure facts a retry condition
 * reads, the condition shape, and the client-visible projection value. These
 * types are browser-safe and carry no runtime values.
 * @module dsh-session-retry/types
 */

/** How one turn ended, copied from its `turn/end` reason. */
export type RetryTurnEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'aborted'; readonly cause: string }
  | { readonly kind: 'error'; readonly error: RetryErrorFacts }
  /** A turn-end kind added by a newer dsh; conditions should not match it blindly. */
  | { readonly kind: 'other'; readonly name: string }

/** Structured model-call failure facts (`LlmFailure`) recorded on the failing turn. */
export interface RetryErrorFacts {
  /** Stable failure code, for example `TRANSPORT`, `SERVER`, `RATE_LIMIT`, or `UNKNOWN`. */
  readonly code: string
  /** Provider or runtime failure message. */
  readonly message: string
  /** HTTP status when the provider reported one. */
  readonly status?: number
}

/** One tool result in the failing turn, in log order. */
export interface RetryToolResult {
  /** Tool name from the matching `tool/call`, or `unknown` when the call was not seen. */
  readonly toolName: string
  /** Whether the tool result was an error. */
  readonly isError: boolean
  /** Model-facing text of an error result, truncated to 2,000 characters; absent on success. */
  readonly errorText?: string
  /** Internal failure name recorded beside an error result, when present. */
  readonly errorName?: string
  /** Internal failure code recorded beside an error result, when present. */
  readonly errorCode?: string
  /** User-facing failure reason recorded beside an error result, when present. */
  readonly errorReason?: string
}

/** One provider retry that `llm-retry` recorded during the failing turn. */
export interface RetryLlmRetry {
  /** Provider route that failed. */
  readonly provider: string
  /** Failure that caused the provider retry. */
  readonly code: string
  /** Failure message that caused the provider retry. */
  readonly message: string
  /** HTTP status of that failure, when reported. */
  readonly status?: number
}

/**
 * The facts a retry condition classifies. Every field comes from standard
 * session events of the most recent finished turn, so the same failure yields
 * the same facts after a restart, a backup restore, or on another host.
 */
export interface RetryFailure {
  /** Session that owns the turn. */
  readonly sessionId: string
  /** Turn number from `turn/start` / `turn/end`. */
  readonly turn: number
  /** How the turn ended. */
  readonly end: RetryTurnEnd
  /** Tool results of the turn in log order (at most the last 50). */
  readonly toolResults: readonly RetryToolResult[]
  /** Provider retries `llm-retry` recorded during the turn, in log order (at most the last 20). */
  readonly llmRetries: readonly RetryLlmRetry[]
  /** Provider route of the turn's last model request, when recorded. */
  readonly provider?: string
  /** Model of the turn's last model request, when recorded. */
  readonly model?: string
}

/** A condition's classification of a failure it recognizes. */
export interface RetryMatch {
  /** Short human reason shown in the chat block and in the model-visible retry note, e.g. `the payments API returned 503`. */
  readonly reason: string
}

/** The session a pending retry belongs to, handed to readiness callbacks. */
export interface RetrySessionRef {
  /** Session with the pending retry. */
  readonly sessionId: string
  /** The failure the condition matched. */
  readonly failure: RetryFailure
  /** The match the condition returned for it. */
  readonly match: RetryMatch
}

/**
 * A retry condition: recognizes a transient failure and, optionally, knows
 * when its dependency is back.
 */
export interface RetryCondition {
  /** Stable id, logged in every retry continuation it causes (lowercase letters, digits, `-`, `.`, `:`, `/`). */
  readonly id: string
  /**
   * Evaluation order: higher runs first; equal priorities keep registration
   * order. The first condition whose `matches` returns a match wins.
   * Default 0; built-in conditions use 0.
   */
  readonly priority?: number
  /**
   * Classify the failure. Return a match to make it retryable, or `undefined`
   * to pass. Must be a pure function of the argument: it runs on the host
   * when the chat block is computed and before every retry.
   * @param failure - facts of the most recent finished turn.
   * @returns the match, or `undefined` when this condition does not apply.
   */
  matches(failure: RetryFailure): RetryMatch | undefined
  /**
   * Readiness preflight, asked when a backoff slot comes due. `false` skips
   * the slot without calling the model; the attempt still counts. A throw or
   * rejection counts as not ready. Absent means always ready.
   * @param ref - the pending retry.
   * @returns whether the dependency is available now.
   */
  isReady?(ref: RetrySessionRef): boolean | Promise<boolean>
  /**
   * Subscribe to an external "the dependency is back" signal. The plugin
   * subscribes while a retry this condition matched is pending and calls the
   * returned disposer when it is no longer pending. Calling `signal` runs the
   * pending attempt immediately instead of waiting for its slot; the backoff
   * schedule stays the fallback.
   * @param ref - the pending retry.
   * @param signal - call when the dependency is available again.
   * @returns a disposer that stops the subscription.
   */
  ready?(ref: RetrySessionRef, signal: () => void): () => void
}

/** How a retry continuation was started. */
export type RetryTrigger = 'schedule' | 'ready' | 'manual'

/**
 * `source` of the logged `user/message` that continues a session after a
 * retryable failure. Its presence in the log is the only record that a retry
 * called the model.
 */
export interface SessionRetryMessageSource {
  readonly kind: 'session-retry'
  /** Attempt number this continuation runs (the failed original turn is attempt 1). */
  readonly attempt: number
  /** Attempt budget in force when the continuation was sent. */
  readonly maxAttempts: number
  /** Id of the condition that matched the failure. */
  readonly conditionId: string
  /** Reason the condition returned. */
  readonly reason: string
  /** What started the continuation. */
  readonly trigger: RetryTrigger
}

/** One backoff slot: when the plugin runs attempt `attempt`. */
export interface RetrySlot {
  /** Attempt number the slot runs. */
  readonly attempt: number
  /** Epoch milliseconds when the slot comes due. */
  readonly at: number
}

/** Client-visible retry state of one session (`useProjection('session-retry')`). */
export interface SessionRetryView {
  /**
   * `pending`: waiting for a slot (the client derives the current slot and the
   * time-based give-up from `slots` and `giveUpAt`). `running`: a continuation
   * was sent and its turn has not ended. `exhausted`: the last allowed attempt
   * failed.
   */
  readonly status: 'pending' | 'running' | 'exhausted'
  /** Attempt number of the failed turn (1 for the original request). */
  readonly failedAttempt: number
  /** Attempt budget. */
  readonly maxAttempts: number
  /** Epoch milliseconds when the failed turn ended. */
  readonly failedAt: number
  /** Remaining slots after the failed attempt, in order; empty when exhausted. */
  readonly slots: readonly RetrySlot[]
  /** Epoch milliseconds after which an unrun budget counts as exhausted. */
  readonly giveUpAt: number
  /** Highest attempt a continuation was sent for since the failure, if any. */
  readonly sentAttempt?: number
  /** Id of the matching condition. */
  readonly conditionId: string
  /** Reason shown to the user. */
  readonly reason: string
  /** Whether the matching condition has a readiness preflight, so due slots may be skipped. */
  readonly waitsForReadiness: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Retry state of the session's latest failed turn; `null` when nothing is pending. */
    'session-retry': SessionRetryView | null
  }
}
