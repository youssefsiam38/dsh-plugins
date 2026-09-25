/**
 * Backoff policy: pure functions shared by the host runtime, the projection,
 * and the browser block. After failed attempt `n` the next attempt waits
 * `n ** exponent` seconds (default exponent 4) with a uniform jitter of
 * ±`jitterRatio` (default 10%). With the default budget of 25 attempts the
 * waits add up to about 20.4 days before the last attempt runs.
 * @module dsh-session-retry/policy
 */

import type { RetrySlot } from './types.ts'

/** Largest wait in seconds: the maximum signed 64-bit nanosecond duration, about 292 years. */
export const MAX_BACKOFF_SECONDS = 9_223_372_036.854775807

/** Tunable backoff parameters. */
export interface BackoffPolicy {
  /** Power applied to the failed-attempt number. */
  readonly exponent: number
  /** Symmetric jitter as a fraction of the base wait, in `[0, 1)`. */
  readonly jitterRatio: number
}

/** Default policy: attempt⁴ seconds, ±10%. */
export const DEFAULT_BACKOFF: BackoffPolicy = { exponent: 4, jitterRatio: 0.1 }

/**
 * Base wait after failed attempt `attempt`, without jitter, capped at
 * {@link MAX_BACKOFF_SECONDS}.
 * @param attempt - number of the attempt that just failed (1-based).
 * @param policy - backoff parameters.
 * @returns seconds to wait before the next attempt.
 */
export function backoffSecondsWithoutJitter(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  return Math.min(attempt ** policy.exponent, MAX_BACKOFF_SECONDS)
}

/**
 * Wait after failed attempt `attempt` with jitter applied. At the cap the
 * jitter is dropped so the result never exceeds it.
 * @param attempt - number of the attempt that just failed (1-based).
 * @param random - uniform sample in `[0, 1)`.
 * @param policy - backoff parameters.
 * @returns seconds to wait before the next attempt.
 */
export function backoffSeconds(attempt: number, random: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const base = backoffSecondsWithoutJitter(attempt, policy)
  if (base === MAX_BACKOFF_SECONDS) return MAX_BACKOFF_SECONDS
  const jittered = base + base * (random * 2 * policy.jitterRatio - policy.jitterRatio)
  return Math.min(jittered, MAX_BACKOFF_SECONDS)
}

/**
 * Deterministic uniform sample in `[0, 1)` for one slot. Seeding by session,
 * failing `turn/end` sequence number, and attempt makes every host and
 * browser compute the same schedule from the log alone.
 * @param sessionId - owning session.
 * @param failureSeq - sequence number of the failing `turn/end`.
 * @param attempt - failed-attempt number the wait follows.
 * @returns a sample in `[0, 1)`.
 */
export function slotRandom(sessionId: string, failureSeq: number, attempt: number): number {
  // FNV-1a over the key, then one mulberry32 round to spread the bits.
  let hash = 0x811c9dc5
  const key = `${sessionId}\u0000${failureSeq}\u0000${attempt}`
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  let state = (hash + 0x6d2b79f5) | 0
  state = Math.imul(state ^ (state >>> 15), state | 1)
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
  return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296
}

/** Full schedule after one failure. */
export interface RetrySchedule {
  /** Slots for attempts `failedAttempt + 1 … maxAttempts`, in order. */
  readonly slots: readonly RetrySlot[]
  /** When an unrun budget counts as exhausted: one more backoff after the last slot, or `failedAt` when no slot remains. */
  readonly giveUpAt: number
}

/**
 * Compute the slots that follow a failed attempt. Slot `k + 1` comes one
 * jittered backoff after slot `k`; the first slot follows the failure itself.
 * @param input - the failure anchor and budget.
 * @param input.sessionId - owning session.
 * @param input.failureSeq - sequence number of the failing `turn/end`.
 * @param input.failedAt - epoch milliseconds of the failing `turn/end`.
 * @param input.failedAttempt - attempt number that failed (1 for the original request).
 * @param input.maxAttempts - attempt budget.
 * @param policy - backoff parameters.
 * @returns the slots and the give-up time.
 */
export function retrySchedule(input: {
  readonly sessionId: string
  readonly failureSeq: number
  readonly failedAt: number
  readonly failedAttempt: number
  readonly maxAttempts: number
}, policy: BackoffPolicy = DEFAULT_BACKOFF): RetrySchedule {
  const slots: RetrySlot[] = []
  let at = input.failedAt
  for (let attempt = input.failedAttempt; attempt <= input.maxAttempts; attempt += 1) {
    at += Math.round(backoffSeconds(attempt, slotRandom(input.sessionId, input.failureSeq, attempt), policy) * 1000)
    if (attempt < input.maxAttempts) slots.push({ attempt: attempt + 1, at })
  }
  return { slots, giveUpAt: slots.length === 0 ? input.failedAt : at }
}

/**
 * Sum of the jitter-free waits a full budget spends before its last attempt.
 * @param maxAttempts - attempt budget.
 * @param policy - backoff parameters.
 * @returns total seconds.
 */
export function totalBackoffSeconds(maxAttempts: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  let total = 0
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) total += backoffSecondsWithoutJitter(attempt, policy)
  return total
}
