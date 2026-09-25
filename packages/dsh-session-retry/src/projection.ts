/**
 * Session projection `session-retry`: persists the pure fold and publishes the
 * client view computed with the conditions loaded on the host.
 * @module dsh-session-retry/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RetryFoldState } from './fold.ts'
import { applyRetryEvent, initialRetryState } from './fold.ts'
import type { SessionRetryView } from './types.ts'

/** Projection key; also the `useProjection` key in the browser. */
export const PROJECTION_KEY = 'session-retry'

const errorFacts = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().optional(),
}).strict()

const turnEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('max-tokens') }).strict(),
  z.object({ kind: z.literal('blocked') }).strict(),
  z.object({ kind: z.literal('aborted'), cause: z.string() }).strict(),
  z.object({ kind: z.literal('error'), error: errorFacts }).strict(),
  z.object({ kind: z.literal('other'), name: z.string() }).strict(),
])

const toolResult = z.object({
  toolName: z.string(),
  isError: z.boolean(),
  errorText: z.string().optional(),
  errorName: z.string().optional(),
  errorCode: z.string().optional(),
  errorReason: z.string().optional(),
}).strict()

const llmRetry = z.object({
  provider: z.string(),
  code: z.string(),
  message: z.string(),
  status: z.number().optional(),
}).strict()

const openTurn = z.object({
  turn: z.number().int().nonnegative(),
  retryAttempt: z.number().int().positive().nullable(),
  toolNames: z.record(z.string(), z.string()),
  toolResults: z.array(toolResult),
  llmRetries: z.array(llmRetry),
  provider: z.string().optional(),
  model: z.string().optional(),
}).strict()

const finishedTurn = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number(),
  attempt: z.number().int().positive(),
  failure: z.object({
    turn: z.number().int().nonnegative(),
    end: turnEnd,
    toolResults: z.array(toolResult),
    llmRetries: z.array(llmRetry),
    provider: z.string().optional(),
    model: z.string().optional(),
  }).strict(),
}).strict()

/** Validates persisted fold state before it seeds a fold. */
export const retryFoldStateSchema = z.object({
  sessionId: z.string(),
  inheritedEventCount: z.number().int().nonnegative(),
  route: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  open: openTurn.nullable(),
  last: finishedTurn.nullable(),
  superseded: z.boolean(),
  sentAttempt: z.number().int().positive().nullable(),
  stopped: z.boolean(),
  stopCommands: z.array(z.string()),
}).strict() as unknown as z.ZodType<RetryFoldState>

const slot = z.object({ attempt: z.number().int().positive(), at: z.number() }).strict()

/** Validates the client value before it leaves the host. */
export const retryViewSchema = z.object({
  status: z.enum(['pending', 'running', 'exhausted']),
  failedAttempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failedAt: z.number(),
  slots: z.array(slot),
  giveUpAt: z.number(),
  sentAttempt: z.number().int().positive().optional(),
  conditionId: z.string(),
  reason: z.string(),
  waitsForReadiness: z.boolean(),
}).strict().nullable() as unknown as z.ZodType<SessionRetryView | null>

/** The projection definition with its client view. */
export type RetryProjectionDefinition = Omit<ProjectionDefinition<typeof PROJECTION_KEY, RetryFoldState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<typeof PROJECTION_KEY, RetryFoldState>['wire']>
}

/**
 * Build the projection definition.
 * @param view - computes the client value from the fold with the live conditions and budget.
 * @returns the definition to register with `ctx.sessionProjections`.
 */
export function retryProjection(
  view: (state: RetryFoldState) => SessionRetryView | null,
): RetryProjectionDefinition {
  return {
    key: PROJECTION_KEY,
    stateSchema: retryFoldStateSchema,
    init: (header, inheritedEventCount) => initialRetryState(header.id, inheritedEventCount),
    apply: (state, event) => applyRetryEvent(state, event),
    wire: { viewSchema: retryViewSchema, view },
    stateVersion: 1,
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retry facts of the latest finished turn (see `dsh-session-retry/fold`). */
    'session-retry': RetryFoldState
  }
}
