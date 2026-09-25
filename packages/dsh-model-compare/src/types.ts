/**
 * Types shared by the Host and browser halves of `dsh-model-compare`: the
 * route bodies, the compare record, and the per-lane statistics view.
 * @module dsh-model-compare/types
 */

/** Which tools a comparison lane may use. */
export type LaneToolMode = 'none' | 'read-only' | 'all'

/** One model a comparison runs. */
export interface CompareModel {
  readonly provider: string
  readonly model: string
  /** Adapter-owned effort id; omitted uses the model's default. */
  readonly reasoningEffort?: string
}

/** One lane: a sibling session that answers the prompt with one model. */
export interface CompareLane extends CompareModel {
  readonly sessionId: string
  /** Display label: the catalog model name, plus the effort when one was chosen. */
  readonly label: string
}

/** Lifecycle of one comparison. */
export type CompareStatus = 'open' | 'adopted' | 'discarded'

/** One comparison as the Host stores it and the browser receives it. */
export interface CompareRecord {
  readonly compareId: string
  readonly sourceSessionId: string
  readonly prompt: string
  /** Epoch milliseconds. */
  readonly createdAt: number
  readonly tools: LaneToolMode
  readonly status: CompareStatus
  readonly lanes: readonly CompareLane[]
  /** The adopted lane (status `adopted`). */
  readonly adoptedLane?: string
  /** The session the conversation continues in (status `adopted`). */
  readonly continuation?: string
}

/** One model of the catalog as the compare picker shows it. */
export interface CatalogModel {
  readonly id: string
  readonly name: string
  /** Selectable effort ids; empty when the model has no effort control. */
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
}

/** One provider group of the catalog. */
export interface CatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
}

/** Settings the browser needs. */
export interface CompareSettings {
  readonly minModels: number
  readonly maxModels: number
  readonly tools: LaneToolMode
  readonly maxPromptChars: number
  /** Output-token cap per lane; 0 leaves the model default. */
  readonly maxOutputTokens: number
}

/** Response of `POST api/model-compare/state`. */
export interface CompareStateResponse {
  readonly settings: CompareSettings
  readonly catalog: {
    readonly default: CompareModel | null
    readonly groups: readonly CatalogGroup[]
    readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  }
  /** The open comparison started from this session, if any. */
  readonly compare: CompareRecord | null
}

/** How a lane's comparison turn ended. */
export type LaneOutcome = 'completed' | 'error' | 'aborted' | 'max-tokens' | 'interrupted' | 'blocked' | 'other'

/**
 * Statistics of a lane's first own turn (the comparison turn), folded from
 * standard session events. Times are epoch milliseconds from the event
 * envelopes; token counts are provider-reported.
 */
export interface LaneStatsView {
  /** `waiting` until the turn starts, `running` until it ends. */
  readonly phase: 'waiting' | 'running' | 'ended'
  readonly outcome?: LaneOutcome
  readonly errorMessage?: string
  /** Turn start to the first streamed token of its first answer. */
  readonly ttftMs?: number
  /** Turn start to turn end. */
  readonly latencyMs?: number
  /** Output tokens per second between the first token and the last answer. */
  readonly tokensPerSecond?: number
  /** Input tokens, cached and uncached. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  /** Provider-reported cost; absent when no request reported one. */
  readonly costUsd?: number
  /** Requests that reported usage without a cost. */
  readonly costUnreported: number
  /** Model requests of the turn, retried attempts included. */
  readonly requests: number
  readonly provider?: string
  readonly model?: string
}
