/** Wire records shared by the Host routes and the browser half. */

/**
 * Where one hunk of a turn's change stands against the file on disk now.
 * - `pending`: the turn-end lines are in the file and nobody decided yet.
 * - `kept`: the turn-end lines are in the file and the user kept the hunk.
 * - `reverted`: the turn-start lines are back in the file.
 * - `conflict`: neither side is found; the file changed after the turn.
 */
export type HunkStatus = 'pending' | 'kept' | 'reverted' | 'conflict'

/** One hunk of a file's turn comparison with its current status. */
export interface ReviewHunk {
  /** 0-based index in the file's comparison. */
  readonly hunk: number
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** Hunk body; each line keeps its `+`, `-`, or space prefix. */
  readonly lines: readonly string[]
  readonly status: HunkStatus
  /**
   * For a `conflict`: how the file's lines at the hunk's expected place differ
   * from the turn-end lines, as prefixed lines (`-` turn end, `+` file now).
   */
  readonly drift?: readonly string[]
}

/** Why a listed file cannot be reviewed hunk by hunk. */
export type UnreviewableReason = 'binary' | 'oversized' | 'unavailable' | 'unreadable'

/** One changed file of a turn. */
export interface ReviewFile {
  /** Index in the turn summary's files. */
  readonly index: number
  /** Path relative to the Session working directory, or absolute. */
  readonly path: string
  /** Label path (relative, `../`, `~`, or absolute; slash-separated). */
  readonly display: string
  readonly added: number
  readonly deleted: number
  /** Whether the file existed at turn start and at turn end. */
  readonly before: boolean
  readonly after: boolean
  /** True when the comparison degraded to whole-file replacement. */
  readonly coarse: boolean
  readonly hunks: readonly ReviewHunk[]
  /** Present when the file has no hunks to review. */
  readonly unreviewable?: UnreviewableReason
  /** Present when the file cannot be read now (`unreadable`) with the file service's message. */
  readonly message?: string
}

/** The review of one turn's changes. */
export interface TurnReview {
  readonly turn: number
  readonly seq: number
  /** Files in summary order, capped by the plugin's `maxFiles`. */
  readonly files: readonly ReviewFile[]
  /** Changed files the Host recorded, including files beyond the cap. */
  readonly total: number
}

/** Change totals of one turn, for the turn-tail chip. */
export interface TurnSummary {
  readonly turn: number
  readonly total: number
  readonly added: number
  readonly deleted: number
}

/** What a keep or revert request applies to. */
export type ReviewTarget =
  | { readonly scope: 'hunk'; readonly index: number; readonly hunk: number }
  | { readonly scope: 'file'; readonly index: number }
  | { readonly scope: 'all' }

/** Outcome of reverting one hunk. */
export interface RevertOutcome {
  readonly index: number
  readonly hunk: number
  readonly outcome: 'reverted' | 'conflict' | 'already' | 'failed'
  /** Present for `failed` and for a conflict found while writing. */
  readonly reason?: string
}

/** Answer of the revert route. */
export interface RevertResponse {
  readonly results: readonly RevertOutcome[]
  /** Whether a note about the reverted hunks was queued for the agent. */
  readonly notified: boolean
  readonly review: TurnReview
}

/** `source` of the user message that tells the agent what the user reverted. */
export interface HunkReviewMessageSource {
  readonly kind: 'hunk-review'
  /** Sequence of the `workspace/changes` event of the reviewed turn. */
  readonly seq: number
  readonly turn: number
  /** Reverted hunks by file path. */
  readonly files: readonly { readonly path: string; readonly hunks: readonly number[] }[]
}
