/**
 * Browser-side review state: turn summaries for the turn-tail chips, and the
 * review of each opened turn with its keep and revert requests. Every change
 * notifies subscribers; reads are keyed by `sessionId:seq`.
 */

import type { ReviewTarget, RevertOutcome, RevertResponse, TurnReview, TurnSummary } from '../types.ts'

/** Document-relative route paths (the page may be served under a path prefix). */
export const CLIENT_ROUTES = {
  summary: 'api/hunk-review/summary',
  review: 'api/hunk-review/review',
  keep: 'api/hunk-review/keep',
  revert: 'api/hunk-review/revert',
} as const

/** A review read: the review, `missing` when the Host no longer serves the turn, an error, or `loading`. */
export type ReviewState = TurnReview | 'loading' | 'missing' | { readonly error: string }

/** A summary read. */
export type SummaryState = TurnSummary | 'loading' | 'missing'

/** Outcome of the last keep or revert of one turn. */
export type ActionNotice =
  | { readonly kind: 'reverted'; readonly results: readonly RevertOutcome[]; readonly notified: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/** Transport for the routes; `fetch` in the browser. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function key(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`
}

async function errorOf(response: Response): Promise<string> {
  try {
    const parsed = await response.json() as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`
  } catch (error: unknown) {
    void error
    return `HTTP ${response.status}`
  }
}

/** Review store shared by the chips and tabs of one page. */
export class ReviewStore {
  private readonly summaries = new Map<string, SummaryState>()
  private readonly reviews = new Map<string, ReviewState>()
  private readonly notices = new Map<string, ActionNotice>()
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  /**
   * @param fetcher - HTTP transport.
   */
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  /**
   * Subscribe to changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns a number that changes on every update (a `useSyncExternalStore` snapshot). */
  snapshot(): number {
    return this.version
  }

  /**
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns the summary state, or undefined before the first read.
   */
  summary(sessionId: string, seq: number): SummaryState | undefined {
    return this.summaries.get(key(sessionId, seq))
  }

  /**
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns the review state, or undefined before the first read.
   */
  review(sessionId: string, seq: number): ReviewState | undefined {
    return this.reviews.get(key(sessionId, seq))
  }

  /**
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns the outcome of the last action, if any.
   */
  notice(sessionId: string, seq: number): ActionNotice | undefined {
    return this.notices.get(key(sessionId, seq))
  }

  /**
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns whether a request of this turn is running.
   */
  busy(sessionId: string, seq: number): boolean {
    return this.pending.has(key(sessionId, seq))
  }

  /**
   * Read a turn's summary once.
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns after the state is published.
   */
  async loadSummary(sessionId: string, seq: number): Promise<void> {
    const id = key(sessionId, seq)
    if (this.summaries.has(id)) return
    this.summaries.set(id, 'loading')
    this.notify()
    let state: SummaryState = 'missing'
    try {
      const response = await this.fetcher(`${CLIENT_ROUTES.summary}?${new URLSearchParams({ sessionId, seq: String(seq) })}`)
      if (response.ok) state = await response.json() as TurnSummary
    } catch (error: unknown) {
      // An unreachable Host shows no chip; a reload reads again.
      void error
    }
    this.summaries.set(id, state)
    this.notify()
  }

  /**
   * Read (or read again) a turn's review.
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @returns after the state is published.
   */
  async loadReview(sessionId: string, seq: number): Promise<void> {
    const id = key(sessionId, seq)
    if (this.reviews.get(id) === undefined) this.reviews.set(id, 'loading')
    this.pending.add(id)
    this.notify()
    let state: ReviewState
    try {
      const response = await this.fetcher(`${CLIENT_ROUTES.review}?${new URLSearchParams({ sessionId, seq: String(seq) })}`)
      state = response.status === 404 ? 'missing' : response.ok ? await response.json() as TurnReview : { error: await errorOf(response) }
    } catch (error: unknown) {
      state = { error: error instanceof Error ? error.message : String(error) }
    }
    this.reviews.set(id, state)
    this.pending.delete(id)
    this.notify()
  }

  /**
   * Keep hunks.
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @param target - what to keep.
   * @returns after the review is published.
   */
  async keep(sessionId: string, seq: number, target: ReviewTarget): Promise<void> {
    const response = await this.post(sessionId, seq, CLIENT_ROUTES.keep, target)
    if (response !== undefined) this.reviews.set(key(sessionId, seq), response as TurnReview)
    this.notify()
  }

  /**
   * Revert hunks.
   * @param sessionId - Session.
   * @param seq - `workspace/changes` sequence.
   * @param target - what to revert.
   * @returns after the review and the notice are published.
   */
  async revert(sessionId: string, seq: number, target: ReviewTarget): Promise<void> {
    const response = await this.post(sessionId, seq, CLIENT_ROUTES.revert, target) as RevertResponse | undefined
    if (response !== undefined) {
      this.reviews.set(key(sessionId, seq), response.review)
      this.notices.set(key(sessionId, seq), { kind: 'reverted', results: response.results, notified: response.notified })
    }
    this.notify()
  }

  private async post(sessionId: string, seq: number, path: string, target: ReviewTarget): Promise<unknown> {
    const id = key(sessionId, seq)
    if (this.pending.has(id)) return undefined
    this.pending.add(id)
    this.notices.delete(id)
    this.notify()
    try {
      const response = await this.fetcher(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, seq, target }),
      })
      if (!response.ok) {
        this.notices.set(id, { kind: 'failed', message: await errorOf(response) })
        return undefined
      }
      return await response.json() as unknown
    } catch (error: unknown) {
      this.notices.set(id, { kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      return undefined
    } finally {
      this.pending.delete(id)
    }
  }

  private notify(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}
