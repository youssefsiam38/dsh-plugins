/**
 * Per-agent retry driver: arms a timer for the next backoff slot, asks the
 * matching condition's readiness preflight when a slot comes due, holds the
 * condition's `ready` subscription while a retry is pending, and sends the
 * logged continuation message.
 * @module dsh-session-retry/runtime
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MatchedFailure } from './decision.ts'
import { phaseAt, retryView } from './decision.ts'
import type { RetryFoldState } from './fold.ts'
import type { RetryBudget } from './decision.ts'
import type { RetrySessionRef, RetryTrigger, SessionRetryMessageSource, SessionRetryView } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-retry': SessionRetryMessageSource
  }
}

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** What the runtime needs from the owning service. */
export interface RetryRuntimeHost {
  /** Current fold state of the agent's session. */
  state(agent: Agent): RetryFoldState
  /** First condition match of the state's latest failure. */
  match(state: RetryFoldState): MatchedFailure | undefined
  /** Budget and backoff in force. */
  readonly budget: RetryBudget
  /** Whether condition `ready` signals may run a pending attempt early. */
  readonly readySignals: boolean
  /** Render the model-visible continuation text. */
  continuation(source: SessionRetryMessageSource): string
  /** Whether the agent is still a live root this runtime may drive. */
  isLive(agent: Agent): boolean
  /** Process-local diagnostics. */
  warn(message: string): void
  /** Clock. */
  now(): number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Outcome of a manual `/retry now`. */
export type ManualRetryResult =
  | { readonly ok: true; readonly attempt: number }
  | { readonly ok: false; readonly reason: 'nothing-pending' | 'running' | 'busy' }

/** One process-local driver for one live root agent. */
export class RetryRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private subscription: { readonly key: string; readonly dispose: () => void } | undefined
  /** Highest slot attempt already evaluated (and skipped) for the anchor `turn/end` seq. */
  private evaluated: { readonly seq: number; readonly attempt: number } | undefined
  /** Anchor seq a continuation was queued for; cleared when the anchor changes. */
  private sentFor: number | undefined
  private readyRequested = false
  private requested = false
  private run: Promise<void> | undefined
  private disposed = false

  /**
   * @param host - owning service callbacks.
   * @param agent - exact live root agent.
   */
  constructor(private readonly host: RetryRuntimeHost, readonly agent: Agent) {}

  /** Recompute timers and subscriptions; coalesces concurrent requests. */
  drive(): void {
    if (this.disposed) return
    this.requested = true
    if (this.run !== undefined) return
    const run = this.drain()
    this.run = run
    void run.then(() => {
      if (this.run === run) this.run = undefined
      if (this.requested && !this.disposed) this.drive()
    })
  }

  /** Stop timers and subscriptions and wait for an in-flight drive. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.clearTimer()
    this.unsubscribe()
    await this.run
  }

  /**
   * Run the pending attempt now (`/retry now`). An exhausted budget reruns the
   * last attempt number.
   * @returns the attempt sent, or why nothing was sent.
   */
  retryNow(): ManualRetryResult {
    const state = this.host.state(this.agent)
    const matched = this.host.match(state)
    const view = retryView(state, matched, this.host.budget)
    const phase = phaseAt(view, this.host.now())
    if (view === null || matched === undefined || phase.kind === 'idle') return { ok: false, reason: 'nothing-pending' }
    if (phase.kind === 'running' || this.sentFor === state.last?.seq) return { ok: false, reason: 'running' }
    const attempt = phase.kind === 'exhausted'
      ? view.maxAttempts
      : (phase.due ?? phase.next)?.attempt ?? view.maxAttempts
    if (!this.send(matched, view, attempt, 'manual')) return { ok: false, reason: 'busy' }
    return { ok: true, attempt }
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false
      try {
        await this.driveOnce()
      } catch (error: unknown) {
        this.host.warn(`session-retry: drive failed for session "${this.agent.id}": ${describe(error)}`)
      }
    }
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(target: number): void {
    this.clearTimer()
    const delay = Math.max(0, Math.min(target - this.host.now(), MAX_TIMER_DELAY_MS))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.drive()
    }, delay)
  }

  private unsubscribe(): void {
    const subscription = this.subscription
    this.subscription = undefined
    if (subscription === undefined) return
    try {
      subscription.dispose()
    } catch (error: unknown) {
      this.host.warn(`session-retry: ready disposer threw for session "${this.agent.id}": ${describe(error)}`)
    }
  }

  private ref(matched: MatchedFailure): RetrySessionRef {
    return { sessionId: this.agent.id, failure: matched.failure, match: matched.match }
  }

  /** Hold exactly one `ready` subscription for the pending failure, keyed by its `turn/end` seq. */
  private subscribe(state: RetryFoldState, matched: MatchedFailure | undefined, pending: boolean): void {
    const ready = matched?.condition.ready
    const key = state.last === null || matched === undefined ? '' : `${state.last.seq}:${matched.condition.id}`
    if (!pending || !this.host.readySignals || ready === undefined || matched === undefined) {
      this.unsubscribe()
      return
    }
    if (this.subscription?.key === key) return
    this.unsubscribe()
    let active = true
    let dispose: () => void = () => {}
    try {
      dispose = ready.call(matched.condition, this.ref(matched), () => {
        if (!active || this.disposed) return
        this.readyRequested = true
        this.drive()
      })
    } catch (error: unknown) {
      this.host.warn(`session-retry: condition "${matched.condition.id}" ready() threw: ${describe(error)}`)
    }
    this.subscription = {
      key,
      dispose: () => {
        active = false
        dispose()
      },
    }
  }

  private async isReady(matched: MatchedFailure): Promise<boolean> {
    const check = matched.condition.isReady
    if (check === undefined) return true
    try {
      return await check.call(matched.condition, this.ref(matched)) === true
    } catch (error: unknown) {
      this.host.warn(`session-retry: condition "${matched.condition.id}" isReady() failed: ${describe(error)}`)
      return false
    }
  }

  private async driveOnce(): Promise<void> {
    this.clearTimer()
    if (this.disposed || !this.host.isLive(this.agent)) {
      this.unsubscribe()
      return
    }
    const state = this.host.state(this.agent)
    const matched = this.host.match(state)
    const view = retryView(state, matched, this.host.budget)
    const now = this.host.now()
    const phase = phaseAt(view, now)
    this.subscribe(state, matched, phase.kind === 'waiting')
    const readyRequested = this.readyRequested
    this.readyRequested = false
    if (phase.kind !== 'waiting' || view === null || matched === undefined || state.last === null) return
    // The agent is busy with something else (a person's turn, a command): the idle transition drives again.
    if (this.agent.status !== 'idle') return

    const anchor = state.last.seq
    // A continuation is queued and its turn has not logged its message yet.
    if (this.sentFor === anchor) return
    if (readyRequested) {
      const slot = phase.due ?? phase.next
      if (slot !== undefined && this.send(matched, view, slot.attempt, 'ready')) return
    }
    const due = phase.due
    const evaluated = this.evaluated?.seq === anchor ? this.evaluated.attempt : 0
    if (due !== undefined && due.attempt > evaluated) {
      this.evaluated = { seq: anchor, attempt: due.attempt }
      const ready = await this.isReady(matched)
      if (this.disposed) return
      if (ready) {
        const current = this.host.state(this.agent)
        // A person wrote, the user stopped retries, or another turn ended while the preflight ran.
        if (current.last?.seq === anchor && !current.superseded && !current.stopped && current.sentAttempt === null
          && this.send(matched, view, due.attempt, 'schedule')) return
      }
    }
    this.arm(phase.next?.at ?? view.giveUpAt)
  }

  /** Queue the logged continuation. Returns false when the agent could not accept it. */
  private send(matched: MatchedFailure, view: SessionRetryView, attempt: number, trigger: RetryTrigger): boolean {
    const source: SessionRetryMessageSource = {
      kind: 'session-retry',
      attempt,
      maxAttempts: view.maxAttempts,
      conditionId: matched.condition.id,
      reason: matched.match.reason,
      trigger,
    }
    try {
      this.agent.followup(createUserMessage({
        content: [{ type: 'text', text: this.host.continuation(source) }],
        source,
      }))
    } catch (error: unknown) {
      this.host.warn(`session-retry: could not queue retry ${attempt} for session "${this.agent.id}": ${describe(error)}`)
      return false
    }
    this.sentFor = this.host.state(this.agent).last?.seq
    this.unsubscribe()
    this.clearTimer()
    return true
  }
}
