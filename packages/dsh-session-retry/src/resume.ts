/**
 * Start-up sweep: find stored sessions whose retry chain is still waiting and
 * load them through the host's own session-open path, so their runtime runs
 * the latest missed slot once. Candidates come from the persisted
 * `session-retry` projection row (no log read); the full log is read only
 * when the deployment mounts no projection cache.
 * @module dsh-session-retry/resume
 */

import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { phaseAt } from './decision.ts'
import type { RetryBudget } from './decision.ts'
import { backoffSecondsWithoutJitter } from './policy.ts'
import type { SessionRetryView } from './types.ts'

/** What the sweep needs from the host. */
export interface ResumeSweepHost {
  /** Every stored session header. */
  list(signal: AbortSignal): Promise<readonly SessionHeader[]>
  /** Whether the session already has a live agent (its runtime drives it). */
  isLive(sessionId: SessionId): boolean
  /** Whether the session is archived; an archived session must not run a step. */
  isArchived(sessionId: SessionId): boolean
  /**
   * The retry view from the persisted projection cache: `null` when nothing
   * is pending, `undefined` when the cache holds no usable row.
   */
  cachedView(header: SessionHeader): SessionRetryView | null | undefined
  /** Fold the stored log into a view; `undefined` when the sweep must not read logs. */
  readView: ((header: SessionHeader, signal: AbortSignal) => Promise<SessionRetryView | null>) | undefined
  /** Load the session the way opening it in the Web UI does; rejects with the reason it could not. */
  open(sessionId: SessionId): Promise<void>
  /** Clock. */
  now(): number
}

/** Sweep limits. */
export interface ResumeSweepOptions {
  readonly budget: RetryBudget
  /** Sessions loaded at the same time. */
  readonly concurrency: number
}

/** One sweep's counts, for the summary log line. */
export interface ResumeSweepSummary {
  /** Stored sessions listed. */
  readonly listed: number
  /** Sessions whose retry chain is waiting and whose failure is inside the horizon. */
  readonly pending: number
  /** Pending sessions loaded. */
  readonly resumed: number
  /** Pending sessions that could not be loaded or read. */
  readonly failed: number
  /** Sessions with no cached projection row that the sweep skipped. */
  readonly uncached: number
}

/**
 * Longest time a retry chain can stay pending after its failing turn: every
 * backoff of the budget at its largest jitter. Older failures are exhausted.
 * @param budget - budget and backoff in force.
 * @returns milliseconds.
 */
export function resumeHorizonMs(budget: RetryBudget): number {
  let seconds = 0
  for (let attempt = 1; attempt <= budget.maxAttempts; attempt += 1) {
    seconds += backoffSecondsWithoutJitter(attempt, budget.backoff) * (1 + budget.backoff.jitterRatio)
  }
  return Math.ceil(seconds * 1000)
}

/**
 * Whether a view is a retry chain the sweep should wake.
 * @param view - retry view of one stored session.
 * @param now - epoch milliseconds.
 * @param horizonMs - see {@link resumeHorizonMs}.
 * @returns true when a slot is due or will come due.
 */
export function isWakeable(view: SessionRetryView | null, now: number, horizonMs: number): boolean {
  if (view === null || view.failedAt < now - horizonMs) return false
  return phaseAt(view, now).kind === 'waiting'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one sweep.
 * @param host - host callbacks.
 * @param options - budget and concurrency.
 * @param signal - aborts the sweep when the plugin unloads.
 * @param warn - per-session diagnostics (session id and error text only).
 * @returns the counts of this sweep.
 */
export async function sweepPendingSessions(
  host: ResumeSweepHost,
  options: ResumeSweepOptions,
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<ResumeSweepSummary> {
  const headers = await host.list(signal)
  const horizonMs = resumeHorizonMs(options.budget)
  let pending = 0
  let resumed = 0
  let failed = 0
  let uncached = 0
  const queue: SessionHeader[] = []
  for (const header of headers) {
    // Subagent children are driven by their parent; a session without a directory cannot be opened.
    if (header.origin === 'subagent' || header.cwd === undefined) continue
    if (host.isLive(header.id) || host.isArchived(header.id)) continue
    queue.push(header)
  }

  const worker = async (): Promise<void> => {
    for (let header = queue.shift(); header !== undefined && !signal.aborted; header = queue.shift()) {
      try {
        let view = host.cachedView(header)
        if (view === undefined) {
          if (host.readView === undefined) {
            uncached += 1
            continue
          }
          view = await host.readView(header, signal)
        }
        if (!isWakeable(view, host.now(), horizonMs)) continue
        pending += 1
        if (signal.aborted || host.isLive(header.id)) continue
        await host.open(header.id)
        resumed += 1
      } catch (error: unknown) {
        failed += 1
        warn(`session-retry: could not resume session "${header.id}": ${describe(error)}`)
      }
    }
  }
  const workers = Math.max(1, Math.min(options.concurrency, queue.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return { listed: headers.length, pending, resumed, failed, uncached }
}
