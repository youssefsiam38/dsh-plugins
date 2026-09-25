/**
 * Built-in retry conditions for model-call failures that outlived
 * `llm-retry`'s own per-request retries. Each is an ordinary registered
 * condition without readiness hooks, so every due slot calls the model.
 * @module dsh-session-retry/conditions
 */

import type { RetryCondition, RetryErrorFacts, RetryFailure } from './types.ts'

/** Settings of one built-in condition. */
export interface BuiltinConditionConfig {
  /** Register the condition. */
  readonly enabled: boolean
  /** Failure codes (`LlmFailure.code`) the condition matches. */
  readonly codes: readonly string[]
  /** HTTP statuses the condition matches regardless of code. */
  readonly statuses: readonly number[]
}

/** Settings of every built-in condition, keyed by condition id. */
export interface BuiltinConditionsConfig {
  /** A provider stream that stopped sending data, or a request timeout. */
  readonly 'provider-stall': BuiltinConditionConfig
  /** A network or connection failure before or during the response. */
  readonly transport: BuiltinConditionConfig
  /** A provider server error (HTTP 5xx). */
  readonly 'server-error': BuiltinConditionConfig
  /** A provider rate limit (HTTP 429). */
  readonly 'rate-limit': BuiltinConditionConfig
}

/** Default built-in settings. */
export const DEFAULT_BUILTIN_CONDITIONS: BuiltinConditionsConfig = {
  'provider-stall': { enabled: true, codes: ['LLM_STREAM_IDLE_TIMEOUT', 'TIMEOUT'], statuses: [408, 504] },
  transport: { enabled: true, codes: ['TRANSPORT', 'STREAM_CLOSED'], statuses: [] },
  'server-error': { enabled: true, codes: ['SERVER'], statuses: [500, 502, 503, 520, 521, 522, 523, 524, 529] },
  'rate-limit': { enabled: true, codes: ['RATE_LIMIT'], statuses: [429] },
}

/** Id prefix of built-in conditions. */
export const BUILTIN_PREFIX = 'builtin:'

const REASONS: Readonly<Record<keyof BuiltinConditionsConfig, (error: RetryErrorFacts) => string>> = {
  'provider-stall': () => 'the model provider stopped responding',
  transport: () => 'the connection to the model provider failed',
  'server-error': error => `the model provider returned a server error${error.status === undefined ? '' : ` (${error.status})`}`,
  'rate-limit': () => 'the model provider rate-limited the request',
}

function turnError(failure: RetryFailure): RetryErrorFacts | undefined {
  return failure.end.kind === 'error' ? failure.end.error : undefined
}

/**
 * Build the enabled built-in conditions.
 * @param config - built-in settings.
 * @returns conditions in a stable order.
 */
export function builtinConditions(config: BuiltinConditionsConfig): RetryCondition[] {
  return (Object.keys(REASONS) as (keyof BuiltinConditionsConfig)[])
    .filter(id => config[id].enabled)
    .map((id): RetryCondition => {
      const { codes, statuses } = config[id]
      return {
        id: `${BUILTIN_PREFIX}${id}`,
        matches(failure) {
          const error = turnError(failure)
          if (error === undefined) return undefined
          const byCode = codes.includes(error.code)
          const byStatus = error.status !== undefined && statuses.includes(error.status)
          return byCode || byStatus ? { reason: REASONS[id](error) } : undefined
        },
      }
    })
}
