/**
 * Pure retry decisions over the fold: which condition matches, the
 * client-visible view, and which slot is due at a given time.
 * @module dsh-session-retry/decision
 */

import type { RetryFoldState } from './fold.ts'
import { latestFailure } from './fold.ts'
import type { BackoffPolicy } from './policy.ts'
import { retrySchedule } from './policy.ts'
import type { RetryCondition, RetryFailure, RetryMatch, RetrySlot, SessionRetryView } from './types.ts'

/** A condition's match of the latest failure. */
export interface MatchedFailure {
  readonly condition: RetryCondition
  readonly match: RetryMatch
  readonly failure: RetryFailure
}

/**
 * Evaluate conditions in order and return the first match. A throwing
 * condition is skipped and reported through `onError`.
 * @param conditions - conditions in evaluation order.
 * @param failure - facts of the latest finished turn.
 * @param onError - receives a condition that threw.
 * @returns the first match, or `undefined`.
 */
export function firstMatch(
  conditions: readonly RetryCondition[],
  failure: RetryFailure,
  onError: (condition: RetryCondition, error: unknown) => void = () => {},
): MatchedFailure | undefined {
  for (const condition of conditions) {
    let match: RetryMatch | undefined
    try {
      match = condition.matches(failure)
    } catch (error: unknown) {
      onError(condition, error)
      continue
    }
    if (match !== undefined && typeof match.reason === 'string') {
      return { condition, match: { reason: match.reason.trim() === '' ? condition.id : match.reason.trim() }, failure }
    }
  }
  return undefined
}

/** Budget and backoff in force. */
export interface RetryBudget {
  readonly maxAttempts: number
  readonly backoff: BackoffPolicy
}

/**
 * The client-visible view of the session's retry state.
 * @param state - folded state.
 * @param matched - match of the latest failure, or `undefined` when no condition matches.
 * @param budget - budget and backoff in force.
 * @returns the view, or `null` when nothing is pending.
 */
export function retryView(state: RetryFoldState, matched: MatchedFailure | undefined, budget: RetryBudget): SessionRetryView | null {
  const last = state.last
  if (last === null || matched === undefined || state.superseded || state.stopped) return null
  const exhausted = last.attempt >= budget.maxAttempts
  const schedule = retrySchedule({
    sessionId: state.sessionId,
    failureSeq: last.seq,
    failedAt: last.time,
    failedAttempt: Math.min(last.attempt, budget.maxAttempts),
    maxAttempts: budget.maxAttempts,
  }, budget.backoff)
  const running = state.sentAttempt !== null
  return {
    status: running ? 'running' : exhausted ? 'exhausted' : 'pending',
    failedAttempt: last.attempt,
    maxAttempts: budget.maxAttempts,
    failedAt: last.time,
    slots: exhausted ? [] : schedule.slots,
    giveUpAt: schedule.giveUpAt,
    ...state.sentAttempt === null ? {} : { sentAttempt: state.sentAttempt },
    conditionId: matched.condition.id,
    reason: matched.match.reason,
    waitsForReadiness: matched.condition.isReady !== undefined,
  }
}

/** What a pending view means at one instant. */
export type RetryPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly attempt: number }
  | { readonly kind: 'exhausted' }
  /**
   * Waiting for `next`. `due` is the latest slot that came due and was not
   * sent (it was skipped as not ready, or is being evaluated right now).
   */
  | { readonly kind: 'waiting'; readonly next: RetrySlot | undefined; readonly due: RetrySlot | undefined }

/**
 * Interpret a view at time `now`. Every slot that came due without a sent
 * continuation counts as a skipped attempt; the attempt shown is the next
 * slot's.
 * @param view - projection value.
 * @param now - epoch milliseconds.
 * @returns the phase at `now`.
 */
export function phaseAt(view: SessionRetryView | null, now: number): RetryPhase {
  if (view === null) return { kind: 'idle' }
  if (view.status === 'running') return { kind: 'running', attempt: view.sentAttempt ?? view.failedAttempt + 1 }
  if (view.status === 'exhausted' || now >= view.giveUpAt) return { kind: 'exhausted' }
  let due: RetrySlot | undefined
  let next: RetrySlot | undefined
  for (const slot of view.slots) {
    if (slot.at <= now) due = slot
    else if (next === undefined) next = slot
  }
  return { kind: 'waiting', next, due }
}
