/**
 * `dsh-session-retry`: automatic session retries with growing backoff.
 *
 * When a turn ends on a failure a registered {@link RetryCondition} matches,
 * the session goes idle and the plugin continues it later with one short,
 * logged `user/message` (source kind `session-retry`). Slots follow the
 * backoff policy in `./policy.ts`; a person writing, `/retry stop`, success,
 * or an exhausted budget ends the chain. The plugin writes no event types of
 * its own: the retry state is a fold of standard events plus time.
 * @module dsh-session-retry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type { BuiltinConditionsConfig } from './conditions.ts'
import { builtinConditions, DEFAULT_BUILTIN_CONDITIONS } from './conditions.ts'
import type { MatchedFailure, RetryBudget } from './decision.ts'
import { firstMatch, retryView } from './decision.ts'
import type { RetryFoldState } from './fold.ts'
import { foldRetryEvents, latestFailure, RETRY_COMMAND } from './fold.ts'
import type { BackoffPolicy } from './policy.ts'
import { DEFAULT_BACKOFF } from './policy.ts'
import { PROJECTION_KEY, retryProjection } from './projection.ts'
import type { ManualRetryResult } from './runtime.ts'
import { RetryRuntime } from './runtime.ts'
import type { RetryCondition, SessionRetryMessageSource, SessionRetryView } from './types.ts'

export type * from './types.ts'
export type { BackoffPolicy, RetrySchedule } from './policy.ts'
export type { BuiltinConditionConfig, BuiltinConditionsConfig } from './conditions.ts'
export type { ManualRetryResult } from './runtime.ts'
export type { RetryFoldState } from './fold.ts'
export {
  backoffSeconds, backoffSecondsWithoutJitter, DEFAULT_BACKOFF, MAX_BACKOFF_SECONDS, retrySchedule, slotRandom,
  totalBackoffSeconds,
} from './policy.ts'
export { phaseAt, retryView } from './decision.ts'
export { foldRetryEvents, latestFailure, retrySourceOf, RETRY_COMMAND } from './fold.ts'
export { PROJECTION_KEY } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session retry conditions and manual controls (`dsh-session-retry`). */
    sessionRetry: SessionRetryService
  }
}

/** Default model-visible continuation template. */
export const DEFAULT_CONTINUATION = '(Automatic retry {attempt}/{maxAttempts}: {reason}. Continue the previous request.)'

/** Plugin configuration (bundle-row `config`). */
export interface Config {
  /** Attempt budget including the original turn. Default 25. */
  maxAttempts?: number
  /** Backoff: wait after failed attempt n is n^exponent seconds ± jitterRatio. */
  backoff?: Partial<BackoffPolicy>
  /** Built-in model-provider conditions, by id. */
  builtins?: { [K in keyof BuiltinConditionsConfig]?: { enabled?: boolean; codes?: string[]; statuses?: number[] } }
  /** Let condition `ready` signals run a pending attempt before its slot. Default true. */
  readySignals?: boolean
  /** Continuation text; `{attempt}`, `{maxAttempts}`, and `{reason}` are substituted. */
  continuation?: string
}

function builtinSchema(id: keyof BuiltinConditionsConfig) {
  const defaults = DEFAULT_BUILTIN_CONDITIONS[id]
  return z.object({
    enabled: z.boolean().default(defaults.enabled),
    codes: z.array(z.string()).default([...defaults.codes]),
    statuses: z.array(z.natural()).default([...defaults.statuses]),
  })
}

/** Condition ids: lowercase segments separated by `-`, `.`, `:`, or `/`. */
const CONDITION_ID = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/

function resolveBuiltins(config: Config['builtins']): BuiltinConditionsConfig {
  const resolved = { ...DEFAULT_BUILTIN_CONDITIONS }
  for (const id of Object.keys(DEFAULT_BUILTIN_CONDITIONS) as (keyof BuiltinConditionsConfig)[]) {
    const override = config?.[id]
    if (override === undefined) continue
    resolved[id] = {
      enabled: override.enabled ?? DEFAULT_BUILTIN_CONDITIONS[id].enabled,
      codes: override.codes ?? DEFAULT_BUILTIN_CONDITIONS[id].codes,
      statuses: override.statuses ?? DEFAULT_BUILTIN_CONDITIONS[id].statuses,
    }
  }
  return resolved
}

interface RegisteredCondition {
  readonly condition: RetryCondition
  readonly order: number
}

/**
 * The `sessionRetry` service: owns the condition registry, the
 * `session-retry` projection, one retry driver per live root agent, and the
 * `/retry now|stop` command when a command registry is mounted.
 */
export class SessionRetryService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections']

  static Config: z<Config> = z.object({
    maxAttempts: z.natural().min(1).max(1000).default(25),
    backoff: z.object({
      exponent: z.number().min(0).max(10).default(DEFAULT_BACKOFF.exponent),
      jitterRatio: z.number().min(0).max(0.99).default(DEFAULT_BACKOFF.jitterRatio),
    }),
    builtins: z.object({
      'provider-stall': builtinSchema('provider-stall'),
      transport: builtinSchema('transport'),
      'server-error': builtinSchema('server-error'),
      'rate-limit': builtinSchema('rate-limit'),
    }),
    readySignals: z.boolean().default(true),
    continuation: z.string().default(DEFAULT_CONTINUATION),
  })

  /** Budget and backoff in force. */
  readonly budget: RetryBudget
  private readonly readySignals: boolean
  private readonly continuationTemplate: string
  private readonly registered: RegisteredCondition[] = []
  private nextOrder = 0
  private readonly runtimes = new Map<Agent, RetryRuntime>()

  /**
   * @param ctx - plugin context.
   * @param config - validated bundle-row configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionRetry')
    const maxAttempts = config.maxAttempts ?? 25
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('dsh-session-retry: maxAttempts must be a positive integer')
    }
    this.budget = {
      maxAttempts,
      backoff: {
        exponent: config.backoff?.exponent ?? DEFAULT_BACKOFF.exponent,
        jitterRatio: config.backoff?.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio,
      },
    }
    this.readySignals = config.readySignals ?? true
    this.continuationTemplate = config.continuation ?? DEFAULT_CONTINUATION

    ctx.effect(() => ctx.sessionProjections.register(retryProjection(state => this.viewOf(state))), 'sessionRetry.projection()')
    for (const condition of builtinConditions(resolveBuiltins(config.builtins))) this.addCondition(condition)

    ctx.on('agent/created', ({ agent }) => {
      this.attach(agent)
      return undefined
    })
    for (const agent of ctx.agents.roots()) this.attach(agent)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' && event.type !== 'user/message' && event.type !== 'command/done') return
      for (const runtime of this.runtimes.values()) {
        if (runtime.agent.session === session) runtime.drive()
      }
    })
    ctx.effect(() => () => {
      const runtimes = [...this.runtimes.values()]
      this.runtimes.clear()
      return Promise.allSettled(runtimes.map(runtime => runtime.dispose())).then(() => undefined)
    }, 'sessionRetry.runtimes()')

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: RETRY_COMMAND,
        description: 'Run the pending automatic retry now, or stop retrying',
        input: { hint: 'now | stop' },
        handler: ({ agent, rawInput }) => this.command(agent, rawInput.trim()),
      })
    })
  }

  /**
   * Register a retry condition for the calling plugin's lifetime.
   * @param condition - the condition; its `id` must be unique among registered conditions.
   * @returns a disposer that removes the condition (also run when the calling plugin unloads).
   */
  registerCondition(condition: RetryCondition): () => void {
    return this.ctx.effect(() => this.addCondition(condition), `sessionRetry.registerCondition(${condition.id})`)
  }

  /**
   * Registered conditions in evaluation order.
   * @returns a snapshot of the registry.
   */
  conditions(): readonly RetryCondition[] {
    return [...this.registered]
      .sort((left, right) => (right.condition.priority ?? 0) - (left.condition.priority ?? 0) || left.order - right.order)
      .map(entry => entry.condition)
  }

  /**
   * The session's current retry view (the same value the browser receives).
   * @param sessionId - live session id.
   * @returns the view, `null` when nothing is pending, or `undefined` for an unknown session.
   */
  view(sessionId: SessionId): SessionRetryView | null | undefined {
    const agent = this.ctx.agents.get(sessionId)
    return agent === undefined ? undefined : this.viewOf(this.stateOf(agent))
  }

  /**
   * Run the session's pending attempt now. The continuation is logged like a scheduled one with trigger `manual`.
   * @param sessionId - live root session id.
   * @returns the attempt sent, or why nothing was sent.
   */
  retryNow(sessionId: SessionId): ManualRetryResult {
    const agent = this.ctx.agents.get(sessionId)
    const runtime = agent === undefined ? undefined : this.runtimes.get(agent)
    return runtime === undefined ? { ok: false, reason: 'nothing-pending' } : runtime.retryNow()
  }

  private addCondition(condition: RetryCondition): () => void {
    if (typeof condition.id !== 'string' || !CONDITION_ID.test(condition.id)) {
      throw new Error(`dsh-session-retry: invalid condition id ${JSON.stringify(condition.id)}`)
    }
    if (typeof condition.matches !== 'function') {
      throw new Error(`dsh-session-retry: condition "${condition.id}" has no matches()`)
    }
    if (this.registered.some(entry => entry.condition.id === condition.id)) {
      throw new Error(`dsh-session-retry: condition "${condition.id}" is already registered`)
    }
    const entry: RegisteredCondition = { condition, order: this.nextOrder++ }
    this.registered.push(entry)
    this.driveAll()
    return () => {
      const index = this.registered.indexOf(entry)
      if (index < 0) return
      this.registered.splice(index, 1)
      this.driveAll()
    }
  }

  private driveAll(): void {
    for (const runtime of this.runtimes.values()) runtime.drive()
  }

  private attach(agent: Agent): void {
    if (this.runtimes.has(agent) || !this.ctx.agents.roots().includes(agent)) return
    const runtime = new RetryRuntime({
      state: target => this.stateOf(target),
      match: state => this.matchOf(state),
      budget: this.budget,
      readySignals: this.readySignals,
      continuation: source => this.render(source),
      isLive: target => this.ctx.agents.get(target.id) === target && this.ctx.agents.roots().includes(target),
      warn: message => { this.ctx.logger.warn(message) },
      now: () => Date.now(),
    }, agent)
    this.runtimes.set(agent, runtime)
    agent.ctx.effect(() => {
      const stopStatus = agent.ctx.on('agent/status', ({ status }) => {
        if (status === 'idle') runtime.drive()
      })
      return async () => {
        stopStatus()
        if (this.runtimes.get(agent) === runtime) this.runtimes.delete(agent)
        await runtime.dispose()
      }
    }, 'sessionRetry.runtime()')
    runtime.drive()
  }

  private stateOf(agent: Agent): RetryFoldState {
    const projected = this.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
    if (projected !== undefined) return projected
    // oxlint-disable-next-line typescript/no-deprecated -- the projection cell is absent only before its first build.
    return foldRetryEvents(agent.id, agent.session.snapshotEvents(), agent.session.inheritedEventCount)
  }

  private matchOf(state: RetryFoldState): MatchedFailure | undefined {
    const failure = latestFailure(state)
    if (failure === undefined) return undefined
    return firstMatch(this.conditions(), failure, (condition, error) => {
      this.ctx.logger.warn(`session-retry: condition "${condition.id}" matches() threw: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private viewOf(state: RetryFoldState): SessionRetryView | null {
    return retryView(state, this.matchOf(state), this.budget)
  }

  private render(source: SessionRetryMessageSource): string {
    return this.continuationTemplate
      .replaceAll('{attempt}', String(source.attempt))
      .replaceAll('{maxAttempts}', String(source.maxAttempts))
      .replaceAll('{reason}', source.reason)
  }

  private command(agent: Agent, input: string): { kind: 'success'; text: string } | { kind: 'error'; text: string } {
    const runtime = this.runtimes.get(agent)
    if (input === 'now') {
      const result = runtime === undefined ? { ok: false as const, reason: 'nothing-pending' as const } : runtime.retryNow()
      if (result.ok) return { kind: 'success', text: `Retry ${result.attempt}/${this.budget.maxAttempts} started.` }
      if (result.reason === 'running') return { kind: 'error', text: 'A retry is already running.' }
      if (result.reason === 'busy') return { kind: 'error', text: 'The session could not accept the retry.' }
      return { kind: 'error', text: 'Nothing to retry.' }
    }
    if (input === 'stop') {
      const view = this.viewOf(this.stateOf(agent))
      if (view === null) return { kind: 'error', text: 'Nothing to stop.' }
      return { kind: 'success', text: 'Automatic retries stopped.' }
    }
    return { kind: 'error', text: 'Usage: /retry now | /retry stop' }
  }
}

export default SessionRetryService
