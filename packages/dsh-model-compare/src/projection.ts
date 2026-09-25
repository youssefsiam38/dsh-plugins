/**
 * Session projection `model-compare`: the statistics fold of a lane's
 * comparison turn, published to the browser as {@link LaneStatsView}.
 * @module dsh-model-compare/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyStatsEvent, initialStats, statsView } from './stats.ts'
import type { LaneStatsState } from './stats.ts'
import type { LaneStatsView } from './types.ts'
// Type-only: the `model-compare` projection map entries.
import type {} from './projection-map.ts'

/** Projection key; also the `useProjection` key in the browser. */
export const PROJECTION_KEY = 'model-compare'

const outcome = z.enum(['completed', 'error', 'aborted', 'max-tokens', 'interrupted', 'blocked', 'other'])

/** Validates persisted fold state before it seeds a fold. */
export const statsStateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  firstTokenAt: z.number().nullable(),
  lastAnswerAt: z.number().nullable(),
  outcome: outcome.nullable(),
  errorMessage: z.string().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costUnreported: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
}).strict() as z.ZodType<LaneStatsState>

/** Validates the client value before it leaves the Host. */
export const statsViewSchema = z.object({
  phase: z.enum(['waiting', 'running', 'ended']),
  outcome: outcome.optional(),
  errorMessage: z.string().optional(),
  ttftMs: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  costUnreported: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
}).strict() as z.ZodType<LaneStatsView>

/** The projection definition with its client view. */
export type StatsProjectionDefinition = Omit<ProjectionDefinition<typeof PROJECTION_KEY, LaneStatsState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<typeof PROJECTION_KEY, LaneStatsState>['wire']>
}

/**
 * Build the projection definition.
 * @returns the definition to register with `ctx.sessionProjections`.
 */
export function statsProjection(): StatsProjectionDefinition {
  return {
    key: PROJECTION_KEY,
    stateSchema: statsStateSchema,
    init: (_header, inheritedEventCount) => initialStats(inheritedEventCount),
    apply: (state, event) => applyStatsEvent(state, event),
    wire: { viewSchema: statsViewSchema, view: statsView },
    stateVersion: 1,
  }
}
