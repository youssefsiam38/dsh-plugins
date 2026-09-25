/**
 * The `hunk-review` Turn data (the latest `workspace/changes` announcement of
 * each Turn) and the right-Sidebar address of a turn's review.
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'

/** The latest change announcement of one Turn; the Host serves the turn's changes by this sequence. */
export interface HunkReviewTurnData {
  readonly seq: number
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** The Turn's latest `workspace/changes` announcement (`dsh-hunk-review`). */
    'hunk-review': HunkReviewTurnData
  }
}

interface State {
  readonly turn: number
  readonly seq?: number
}

function turnOf(data: unknown): number | undefined {
  if (data === null || typeof data !== 'object' || !('turn' in data)) return undefined
  const turn = data.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1 ? turn : undefined
}

/** Publishes each Turn's latest `workspace/changes` sequence as Turn data. */
export const hunkReviewDefinition: ConversationNodeDefinition<State> = {
  kind: 'hunk-review',
  match: (event) => {
    if (event.type === 'turn/start') {
      const turn = turnOf(event.data)
      return turn === undefined ? null : { id: String(turn), role: 'start' }
    }
    if (event.type === 'workspace/changes') {
      const turn = turnOf(event.data)
      return turn === undefined ? null : { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => ({ turn: turnOf(match.event.data) ?? 0 }),
  update: (context, match) => (match.event.type === 'workspace/changes' ? { ...context.state, seq: match.event.seq } : context.state),
  buildLocationData: (context, scope, previous) => {
    const state = context.state
    if (scope !== 'turn' || state?.seq === undefined) return null
    if (previous?.kind === 'turn' && previous.key === 'hunk-review' && previous.value.seq === state.seq) return previous
    return { kind: 'turn', turn: state.turn, key: 'hunk-review', value: { seq: state.seq, turn: state.turn } }
  },
}

/** Resource-address prefix of a turn's review. */
export const REVIEW_ADDRESS = 'dsh-resource://hunk-review/session/'

/** Coordinates of one turn's review. */
export interface ReviewCoordinates {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
}

/**
 * @param coordinates - Session, announcing event, and turn.
 * @returns the review's `dsh-resource://hunk-review/session/…` address.
 */
export function reviewAddress(coordinates: ReviewCoordinates): string {
  return `${REVIEW_ADDRESS}${encodeURIComponent(coordinates.sessionId)}/${coordinates.seq}/${coordinates.turn}`
}

/**
 * @param address - a resource address.
 * @returns the coordinates, or undefined for any other address.
 */
export function parseReviewAddress(address: string): ReviewCoordinates | undefined {
  if (!address.startsWith(REVIEW_ADDRESS)) return undefined
  const parts = address.slice(REVIEW_ADDRESS.length).split('/')
  if (parts.length !== 3) return undefined
  const [sessionId, seq, turn] = parts as [string, string, string]
  if (sessionId === '' || !/^\d+$/.test(seq) || !/^[1-9]\d*$/.test(turn)) return undefined
  try {
    return { sessionId: decodeURIComponent(sessionId), seq: Number(seq), turn: Number(turn) }
  } catch (error: unknown) {
    // A malformed percent sequence is not an address this plugin minted.
    void error
    return undefined
  }
}
