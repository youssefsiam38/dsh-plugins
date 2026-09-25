/**
 * Pure fold of standard session events into the retry facts of the latest
 * finished turn. The plugin writes no event types of its own: every fact here
 * comes from `turn/start`, `turn/end`, `user/message`, `tool/call`,
 * `tool/result`, `llm/retry`, `request/context`, `command/run`, and
 * `command/done`, so the fold is identical on every host that reads the log.
 * @module dsh-session-retry/fold
 */

import type {
  RetryFailure, RetryLlmRetry, RetryToolResult, RetryTurnEnd, SessionRetryMessageSource,
} from './types.ts'

/** Name of the slash command the plugin registers. */
export const RETRY_COMMAND = 'retry'

const MAX_TOOL_RESULTS = 50
const MAX_LLM_RETRIES = 20
const MAX_ERROR_TEXT = 2_000

/** Facts gathered while a turn is open. */
export interface OpenTurnFacts {
  readonly turn: number
  /** Attempt a retry continuation started this turn with; `null` when a person or another producer did. */
  readonly retryAttempt: number | null
  readonly toolNames: Readonly<Record<string, string>>
  readonly toolResults: readonly RetryToolResult[]
  readonly llmRetries: readonly RetryLlmRetry[]
  readonly provider?: string
  readonly model?: string
}

/** Facts of the latest finished turn, the anchor every retry decision starts from. */
export interface FinishedTurnFacts {
  /** Sequence number of its `turn/end`. */
  readonly seq: number
  /** Epoch milliseconds of its `turn/end`. */
  readonly time: number
  /** Attempt number the turn ran (1 unless a retry continuation started it). */
  readonly attempt: number
  readonly failure: Omit<RetryFailure, 'sessionId'>
}

/** Complete fold state; JSON-serializable so the projection cache can persist it. */
export interface RetryFoldState {
  readonly sessionId: string
  /** Events before this offset belong to a fork parent and are ignored. */
  readonly inheritedEventCount: number
  /** Latest `request/context` route, carried into the next turn. */
  readonly route: { readonly provider: string; readonly model: string } | null
  readonly open: OpenTurnFacts | null
  readonly last: FinishedTurnFacts | null
  /** A person wrote after the latest finished turn: nothing is pending. */
  readonly superseded: boolean
  /** Highest attempt a continuation was sent for after the latest finished turn. */
  readonly sentAttempt: number | null
  /** `/retry stop` succeeded after the latest finished turn. */
  readonly stopped: boolean
  /** Command ids of `/retry stop` runs waiting for their `command/done`. */
  readonly stopCommands: readonly string[]
}

/** Minimal event view the fold reads; structurally compatible with `SessionEvent`. */
export interface FoldEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * Initial state for one session.
 * @param sessionId - owning session.
 * @param inheritedEventCount - fork-inherited prefix length to skip.
 * @returns the empty state.
 */
export function initialRetryState(sessionId: string, inheritedEventCount = 0): RetryFoldState {
  return {
    sessionId,
    inheritedEventCount,
    route: null,
    open: null,
    last: null,
    superseded: false,
    sentAttempt: null,
    stopped: false,
    stopCommands: [],
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Read a retry continuation source from a `user/message` payload.
 * @param message - logged `user/message` data.
 * @returns the source, or `undefined` for any other producer.
 */
export function retrySourceOf(message: unknown): SessionRetryMessageSource | undefined {
  const source = record(record(message)?.['source'])
  if (source?.['kind'] !== 'session-retry') return undefined
  const attempt = positiveInteger(source['attempt'])
  const maxAttempts = positiveInteger(source['maxAttempts'])
  const conditionId = text(source['conditionId'])
  const reason = text(source['reason'])
  const trigger = source['trigger']
  if (attempt === undefined || maxAttempts === undefined || conditionId === undefined || reason === undefined
    || (trigger !== 'schedule' && trigger !== 'ready' && trigger !== 'manual')) return undefined
  return { kind: 'session-retry', attempt, maxAttempts, conditionId, reason, trigger }
}

function sourceKind(message: unknown): string | undefined {
  return text(record(record(message)?.['source'])?.['kind'])
}

function errorFacts(value: unknown): { code: string; message: string; status?: number } {
  const failure = record(value)
  const status = failure?.['status']
  return {
    code: text(failure?.['code']) ?? 'UNKNOWN',
    message: text(failure?.['message']) ?? '',
    ...typeof status === 'number' && Number.isFinite(status) ? { status } : {},
  }
}

function turnEnd(reason: unknown): RetryTurnEnd {
  const value = record(reason)
  const kind = text(value?.['kind'])
  switch (kind) {
    case 'completed':
    case 'max-tokens':
    case 'blocked':
      return { kind }
    case 'aborted':
      return { kind: 'aborted', cause: text(record(value?.['reason'])?.['kind']) ?? 'unknown' }
    case 'error':
      return { kind: 'error', error: errorFacts(value?.['error']) }
    default:
      // TurnEndReasonMap is merge-extensible; keep an unknown kind visible by name.
      return { kind: 'other', name: kind ?? 'unknown' }
  }
}

function errorTextOf(message: unknown): string {
  const content = record(message)?.['content']
  if (!Array.isArray(content)) return ''
  const joined = content
    .map(block => (record(block)?.['type'] === 'text' ? text(record(block)?.['text']) ?? '' : ''))
    .filter(part => part !== '')
    .join('\n')
  return joined.length > MAX_ERROR_TEXT ? joined.slice(0, MAX_ERROR_TEXT) : joined
}

function openTurn(state: RetryFoldState, turn: number): OpenTurnFacts {
  return {
    turn,
    retryAttempt: null,
    toolNames: {},
    toolResults: [],
    llmRetries: [],
    ...state.route === null ? {} : { provider: state.route.provider, model: state.route.model },
  }
}

/**
 * Apply one session event.
 * @param state - state before the event.
 * @param event - the next logged event.
 * @returns the state after the event; the same reference when it is irrelevant.
 */
export function applyRetryEvent(state: RetryFoldState, event: FoldEvent): RetryFoldState {
  if (event.seq < state.inheritedEventCount) return state
  const data = record(event.data)
  switch (event.type) {
    case 'turn/start': {
      const turn = positiveInteger(data?.['turn']) ?? (state.open?.turn ?? 0) + 1
      // The user message that wakes a turn is logged after turn/start; a retry message sets retryAttempt then.
      return { ...state, open: openTurn(state, turn) }
    }
    case 'user/message': {
      const retry = retrySourceOf(event.data)
      if (retry !== undefined) {
        const sentAttempt = Math.max(state.sentAttempt ?? 0, retry.attempt)
        return {
          ...state,
          sentAttempt,
          ...state.open === null ? {} : { open: { ...state.open, retryAttempt: retry.attempt } },
        }
      }
      if (sourceKind(event.data) !== 'user') return state
      return {
        ...state,
        superseded: true,
        ...state.open === null ? {} : { open: { ...state.open, retryAttempt: null } },
      }
    }
    case 'request/context': {
      const provider = text(data?.['provider'])
      const model = text(data?.['model'])
      if (provider === undefined || model === undefined) return state
      return {
        ...state,
        route: { provider, model },
        ...state.open === null ? {} : { open: { ...state.open, provider, model } },
      }
    }
    case 'tool/call': {
      if (state.open === null) return state
      const callId = text(data?.['callId'])
      const name = text(data?.['name'])
      if (callId === undefined || name === undefined) return state
      return { ...state, open: { ...state.open, toolNames: { ...state.open.toolNames, [callId]: name } } }
    }
    case 'tool/result': {
      if (state.open === null) return state
      const message = record(data?.['message'])
      const callId = text(message?.['toolCallId'])
      const isError = message?.['isError'] === true
      const error = record(data?.['error'])
      const result: RetryToolResult = {
        toolName: (callId === undefined ? undefined : state.open.toolNames[callId]) ?? 'unknown',
        isError,
        ...isError ? { errorText: errorTextOf(message) } : {},
        ...isError && text(error?.['name']) !== undefined ? { errorName: text(error?.['name']) as string } : {},
        ...isError && text(error?.['code']) !== undefined ? { errorCode: text(error?.['code']) as string } : {},
        ...isError && text(error?.['reason']) !== undefined ? { errorReason: text(error?.['reason']) as string } : {},
      }
      const toolResults = [...state.open.toolResults, result].slice(-MAX_TOOL_RESULTS)
      return { ...state, open: { ...state.open, toolResults } }
    }
    case 'llm/retry': {
      if (state.open === null) return state
      const failure = errorFacts(data?.['failure'])
      const retry: RetryLlmRetry = { provider: text(data?.['provider']) ?? 'unknown', ...failure }
      return { ...state, open: { ...state.open, llmRetries: [...state.open.llmRetries, retry].slice(-MAX_LLM_RETRIES) } }
    }
    case 'turn/end': {
      const open = state.open
      const turn = positiveInteger(data?.['turn']) ?? open?.turn ?? 0
      const facts = open ?? openTurn(state, turn)
      return {
        ...state,
        open: null,
        last: {
          seq: event.seq,
          time: event.time,
          attempt: facts.retryAttempt ?? 1,
          failure: {
            turn,
            end: turnEnd(data?.['reason']),
            toolResults: facts.toolResults,
            llmRetries: facts.llmRetries,
            ...facts.provider === undefined ? {} : { provider: facts.provider },
            ...facts.model === undefined ? {} : { model: facts.model },
          },
        },
        superseded: false,
        sentAttempt: null,
        stopped: false,
        stopCommands: [],
      }
    }
    case 'command/run': {
      if (text(data?.['name']) !== RETRY_COMMAND || (text(data?.['args']) ?? '').trim() !== 'stop') return state
      const commandId = text(data?.['commandId'])
      return commandId === undefined ? state : { ...state, stopCommands: [...state.stopCommands, commandId] }
    }
    case 'command/done': {
      const commandId = text(data?.['commandId'])
      if (commandId === undefined || !state.stopCommands.includes(commandId)) return state
      return {
        ...state,
        stopCommands: state.stopCommands.filter(id => id !== commandId),
        stopped: state.stopped || data?.['kind'] === 'success',
      }
    }
    default:
      return state
  }
}

/**
 * Fold a complete event list.
 * @param sessionId - owning session.
 * @param events - the session's events in log order.
 * @param inheritedEventCount - fork-inherited prefix length to skip.
 * @returns the folded state.
 */
export function foldRetryEvents(sessionId: string, events: Iterable<FoldEvent>, inheritedEventCount = 0): RetryFoldState {
  let state = initialRetryState(sessionId, inheritedEventCount)
  for (const event of events) state = applyRetryEvent(state, event)
  return state
}

/**
 * The failure facts of the latest finished turn, as conditions receive them.
 * @param state - folded state.
 * @returns the facts, or `undefined` before any turn finished.
 */
export function latestFailure(state: RetryFoldState): RetryFailure | undefined {
  return state.last === null ? undefined : { sessionId: state.sessionId, ...state.last.failure }
}
