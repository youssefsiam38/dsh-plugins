/**
 * Pure fold of a lane's comparison turn into {@link LaneStatsView}. It reads
 * only standard events (`turn/start`, `assistant/message`,
 * `assistant/attempt`, `turn/end`) and their envelope times, skips the
 * fork-inherited prefix, and stops at the end of the first own turn.
 * @module dsh-model-compare/stats
 */

import { assistantStreamFirstTokenTime, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { LaneOutcome, LaneStatsView } from './types.ts'

/** The event fields the fold reads. */
export interface StatsEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** JSON-serializable fold state. */
export interface LaneStatsState {
  readonly inheritedEventCount: number
  /** Turn number of the comparison turn once it started. */
  readonly turn: number | null
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly firstTokenAt: number | null
  readonly lastAnswerAt: number | null
  readonly outcome: LaneOutcome | null
  readonly errorMessage: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  readonly costUsd: number | null
  readonly costUnreported: number
  readonly requests: number
  readonly provider: string | null
  readonly model: string | null
}

/**
 * Initial state for one session.
 * @param inheritedEventCount - length of the fork-inherited prefix to skip.
 * @returns the empty fold.
 */
export function initialStats(inheritedEventCount = 0): LaneStatsState {
  return {
    inheritedEventCount,
    turn: null,
    startedAt: null,
    endedAt: null,
    firstTokenAt: null,
    lastAnswerAt: null,
    outcome: null,
    errorMessage: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    costUnreported: 0,
    requests: 0,
    provider: null,
    model: null,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'error', 'aborted', 'max-tokens', 'interrupted', 'blocked'])

/**
 * Add one request's usage. `costUsd` is read structurally: dsh builds that
 * report provider cost carry it on `TokenUsage`, older ones do not.
 */
function addUsage(state: LaneStatsState, usage: TokenUsage | undefined): LaneStatsState {
  if (usage === undefined) return { ...state, requests: state.requests + 1 }
  const cost: unknown = (usage as TokenUsage & { costUsd?: unknown }).costUsd
  const reported = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
  return {
    ...state,
    requests: state.requests + 1,
    inputTokens: state.inputTokens + count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens),
    outputTokens: state.outputTokens + count(usage.outputTokens),
    reasoningTokens: state.reasoningTokens + count(usage.reasoningTokens),
    cacheReadTokens: state.cacheReadTokens + count(usage.cacheReadTokens),
    costUsd: reported ? (state.costUsd ?? 0) + cost : state.costUsd,
    costUnreported: reported ? state.costUnreported : state.costUnreported + 1,
  }
}

function streamOf(data: Record<string, unknown>): readonly AssistantStreamRecord[] {
  return Array.isArray(data['stream']) ? data['stream'] as AssistantStreamRecord[] : []
}

/**
 * Apply one event.
 * @param state - current fold.
 * @param event - next session event in seq order.
 * @returns the next fold (the same object when the event changes nothing).
 */
export function applyStatsEvent(state: LaneStatsState, event: StatsEvent): LaneStatsState {
  if (event.seq < state.inheritedEventCount || state.endedAt !== null) return state
  const data = record(event.data)
  if (data === undefined) return state
  if (event.type === 'turn/start') {
    if (state.turn !== null || typeof data['turn'] !== 'number') return state
    return { ...state, turn: data['turn'], startedAt: event.time }
  }
  if (state.turn === null || data['turn'] !== state.turn) return state
  switch (event.type) {
    case 'assistant/message': {
      const stream = streamOf(data)
      const first = assistantStreamFirstTokenTime(stream)
      const usage = record(data['usage']) as TokenUsage | undefined ?? lastAssistantStreamChunk(stream, 'usage')?.usage
      const source = record(record(data['message'])?.['source'])
      const next = addUsage(state, usage)
      return {
        ...next,
        firstTokenAt: state.firstTokenAt ?? first ?? null,
        lastAnswerAt: event.time,
        provider: typeof source?.['provider'] === 'string' ? source['provider'] : state.provider,
        model: typeof source?.['model'] === 'string' ? source['model'] : state.model,
      }
    }
    case 'assistant/attempt': {
      const stream = streamOf(data)
      const usage = lastAssistantStreamChunk(stream, 'usage')?.usage
      const first = assistantStreamFirstTokenTime(stream)
      return { ...addUsage(state, usage), firstTokenAt: state.firstTokenAt ?? first ?? null }
    }
    case 'turn/end': {
      const reason = record(data['reason'])
      const kind = typeof reason?.['kind'] === 'string' ? reason['kind'] : 'other'
      const error = record(reason?.['error'])
      const message = typeof error?.['message'] === 'string' ? error['message'] : null
      return {
        ...state,
        endedAt: event.time,
        outcome: (OUTCOMES.has(kind) ? kind : 'other') as LaneOutcome,
        errorMessage: message,
      }
    }
    default:
      return state
  }
}

/**
 * Fold a whole event list.
 * @param events - events in seq order.
 * @param inheritedEventCount - fork-inherited prefix length.
 * @returns the fold.
 */
export function foldStats(events: Iterable<StatsEvent>, inheritedEventCount = 0): LaneStatsState {
  let state = initialStats(inheritedEventCount)
  for (const event of events) state = applyStatsEvent(state, event)
  return state
}

/**
 * Client view of a fold.
 * @param state - the fold.
 * @returns the statistics the lane header shows.
 */
export function statsView(state: LaneStatsState): LaneStatsView {
  const phase = state.startedAt === null ? 'waiting' : state.endedAt === null ? 'running' : 'ended'
  const ttftMs = state.startedAt !== null && state.firstTokenAt !== null ? Math.max(0, state.firstTokenAt - state.startedAt) : undefined
  const latencyMs = state.startedAt !== null && state.endedAt !== null ? Math.max(0, state.endedAt - state.startedAt) : undefined
  const decodeMs = state.firstTokenAt !== null && state.lastAnswerAt !== null ? state.lastAnswerAt - state.firstTokenAt : 0
  const tokensPerSecond = decodeMs > 0 && state.outputTokens > 0 ? state.outputTokens / (decodeMs / 1000) : undefined
  return {
    phase,
    ...state.outcome === null ? {} : { outcome: state.outcome },
    ...state.errorMessage === null ? {} : { errorMessage: state.errorMessage },
    ...ttftMs === undefined ? {} : { ttftMs },
    ...latencyMs === undefined ? {} : { latencyMs },
    ...tokensPerSecond === undefined ? {} : { tokensPerSecond },
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    reasoningTokens: state.reasoningTokens,
    cacheReadTokens: state.cacheReadTokens,
    ...state.costUsd === null ? {} : { costUsd: state.costUsd },
    costUnreported: state.costUnreported,
    requests: state.requests,
    ...state.provider === null ? {} : { provider: state.provider },
    ...state.model === null ? {} : { model: state.model },
  }
}
