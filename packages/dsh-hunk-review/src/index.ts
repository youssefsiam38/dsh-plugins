/**
 * `dsh-hunk-review`: review the agent's file edits hunk by hunk.
 *
 * The baseline is the turn-start state that `@deepseek-ai/dsh-workspace-changes`
 * records for every top-level turn: its `ctx.workspaceChanges` service serves
 * each turn's changed files and their comparisons while the Session lives.
 * This plugin places every hunk in the file as it is now (pending, kept,
 * reverted, or in conflict), remembers which hunks the user kept, and reverts
 * chosen hunks by writing the reverse patch through `ctx.fs` with a version
 * guard. After a revert it queues one `user/message` with source kind
 * `hunk-review` through `agent.inject()`, so the agent reads what was reverted
 * at its next request and the fact is in the Session log.
 *
 * Routes exist only on the authenticated Web connection; no model tool exists.
 * @module dsh-hunk-review
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { frameReverts } from './message.ts'
import { TurnReviewer } from './review.ts'
import type { HunkReviewMessageSource, ReviewTarget, RevertResponse, TurnReview, TurnSummary } from './types.ts'

export type * from './types.ts'
export { drift, findNearest, joinLines, placeHunks, reverseHunks, sides, splitLines } from './hunks.ts'
export type { FileLines, HunkLike, Placement, ReverseResult } from './hunks.ts'
export { escapeFramed, frameReverts } from './message.ts'
export type { RevertedFile, RevertedHunk } from './message.ts'
export { TurnReviewer } from './review.ts'
export type { ReviewFs, ReviewLimits, RevertRun } from './review.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hunk-review': HunkReviewMessageSource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hunk-by-hunk review of the agent's file edits (`dsh-hunk-review`). */
    hunkReview: HunkReviewService
  }
}

/** Route paths below the Web server's `/api` channel. */
export const ROUTES = {
  summary: '/api/hunk-review/summary',
  review: '/api/hunk-review/review',
  keep: '/api/hunk-review/keep',
  revert: '/api/hunk-review/revert',
} as const

/** Plugin configuration (bundle-row `config`). */
export interface Config {
  /** Files reviewed per turn. Default 200. */
  maxFiles?: number
  /** Largest file read for review and revert, in bytes. Default 2 MiB. */
  maxFileBytes?: number
  /** UTF-8 bytes of reverted hunk lines in the note to the agent. Default 24000. */
  messageMaxBytes?: number
  /** Allow reverts while the agent is running a turn. Default false. */
  revertWhileRunning?: boolean
}

interface ResolvedConfig {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly messageMaxBytes: number
  readonly revertWhileRunning: boolean
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch (error: unknown) {
    void error
    throw new RouteError(400, 'The request body is not JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RouteError(400, 'The request body must be a JSON object.')
  return parsed as Record<string, unknown>
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 1024) throw new RouteError(400, `"${key}" must be a non-empty string.`)
  return value
}

function natural(value: unknown, key: string): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new RouteError(400, `"${key}" must be a non-negative integer.`)
  return number
}

/**
 * Validate a keep or revert target.
 * @param value - decoded JSON.
 * @returns the target.
 */
export function parseTarget(value: unknown): ReviewTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RouteError(400, '"target" must be an object.')
  const fields = value as Record<string, unknown>
  switch (fields['scope']) {
    case 'hunk': return { scope: 'hunk', index: natural(fields['index'], 'index'), hunk: natural(fields['hunk'], 'hunk') }
    case 'file': return { scope: 'file', index: natural(fields['index'], 'index') }
    case 'all': return { scope: 'all' }
    default: throw new RouteError(400, '"target.scope" must be "hunk", "file", or "all".')
  }
}

/**
 * The hunks a target names in a review: a hunk names itself; a file or
 * `all` names its pending hunks, so kept hunks stay.
 * @param review - the current review.
 * @param target - the target.
 * @returns hunk indexes by file index.
 */
export function selectHunks(review: TurnReview, target: ReviewTarget): Map<number, number[]> {
  const chosen = new Map<number, number[]>()
  if (target.scope === 'hunk') {
    const file = review.files.find(candidate => candidate.index === target.index)
    if (file?.hunks[target.hunk] === undefined) throw new RouteError(404, 'The hunk is not part of this review.')
    chosen.set(target.index, [target.hunk])
    return chosen
  }
  const files = target.scope === 'all' ? review.files : review.files.filter(file => file.index === target.index)
  if (files.length === 0 && target.scope === 'file') throw new RouteError(404, 'The file is not part of this review.')
  for (const file of files) {
    const pending = file.hunks.filter(hunk => hunk.status === 'pending').map(hunk => hunk.hunk)
    if (pending.length > 0) chosen.set(file.index, pending)
  }
  return chosen
}

/**
 * The `hunkReview` service: kept-hunk memory per turn and the
 * `/api/hunk-review/*` routes.
 */
export class HunkReviewService extends Service {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    maxFiles: z.natural().min(1).max(5000).default(200),
    maxFileBytes: z.natural().min(1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
    messageMaxBytes: z.natural().min(1024).max(1024 * 1024).default(24_000),
    revertWhileRunning: z.boolean().default(false),
  })

  /** Resolved settings. */
  readonly settings: ResolvedConfig
  /** Kept hunks (`index:hunk`) by `sessionId:seq`. */
  private readonly kept = new Map<string, Set<string>>()
  /** One revert at a time per Session. */
  private readonly busy = new Set<string>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - plugin context.
   * @param config - validated bundle-row configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'hunkReview')
    this.settings = {
      maxFiles: config.maxFiles ?? 200,
      maxFileBytes: config.maxFileBytes ?? 2 * 1024 * 1024,
      messageMaxBytes: config.messageMaxBytes ?? 24_000,
      revertWhileRunning: config.revertWhileRunning ?? false,
    }
    ctx.effect(() => () => { this.lifetime.abort() }, 'hunkReview.lifetime()')
    ctx.on('session/disposed', (session) => {
      for (const key of [...this.kept.keys()]) if (key.startsWith(`${session.id}:`)) this.kept.delete(key)
    })
    ctx.inject(['connection', 'fs', 'workspaceChanges'], (web) => {
      this.registerRoutes(web, new TurnReviewer(web.fs, web.workspaceChanges, this.settings))
    })
  }

  /**
   * Kept hunks of one turn.
   * @param sessionId - Session.
   * @param seq - the `workspace/changes` event sequence.
   * @returns the keys (`index:hunk`), live.
   */
  keptHunks(sessionId: string, seq: number): Set<string> {
    const key = `${sessionId}:${seq}`
    let set = this.kept.get(key)
    if (set === undefined) {
      set = new Set()
      this.kept.set(key, set)
    }
    return set
  }

  private registerRoutes(web: Context, reviewer: TurnReviewer): void {
    const route = (path: string, method: 'GET' | 'POST', handler: (request: Request) => Promise<Response>): void => {
      web.connection.fetch.register({
        path,
        methods: [method],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (error: unknown) {
            if (error instanceof RouteError) return json({ error: error.message }, error.status)
            web.logger.warn(`hunk-review: ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            return json({ error: 'The request failed.' }, 500)
          }
        },
      })
    }
    const coordinates = (fields: Record<string, unknown>): { sessionId: SessionId; seq: number } => ({
      sessionId: SessionId(text(fields['sessionId'], 'sessionId')),
      seq: natural(fields['seq'], 'seq'),
    })
    const query = (request: Request): Record<string, unknown> => Object.fromEntries(new URL(request.url).searchParams)
    const reviewOf = async (sessionId: SessionId, seq: number, signal: AbortSignal): Promise<TurnReview> => {
      const review = await reviewer.review(sessionId, seq, this.keptHunks(sessionId, seq), signal)
      if (review === undefined) throw new RouteError(404, 'This turn\'s changes are no longer available on the server.')
      return review
    }

    route(ROUTES.summary, 'GET', (request) => {
      const { sessionId, seq } = coordinates(query(request))
      const summary = reviewer.summary(sessionId, seq)
      if (summary === undefined) throw new RouteError(404, 'This turn\'s changes are no longer available on the server.')
      const answer: TurnSummary = { turn: summary.turn, total: summary.total, added: summary.added, deleted: summary.deleted }
      return Promise.resolve(json(answer))
    })

    route(ROUTES.review, 'GET', async (request) => {
      const { sessionId, seq } = coordinates(query(request))
      return json(await reviewOf(sessionId, seq, AbortSignal.any([request.signal, this.lifetime.signal])))
    })

    route(ROUTES.keep, 'POST', async (request) => {
      const fields = await body(request)
      const { sessionId, seq } = coordinates(fields)
      const target = parseTarget(fields['target'])
      const signal = AbortSignal.any([request.signal, this.lifetime.signal])
      const review = await reviewOf(sessionId, seq, signal)
      const kept = this.keptHunks(sessionId, seq)
      for (const [index, hunks] of selectHunks(review, target)) for (const hunk of hunks) kept.add(`${index}:${hunk}`)
      return json(await reviewOf(sessionId, seq, signal))
    })

    route(ROUTES.revert, 'POST', async (request) => {
      const fields = await body(request)
      const { sessionId, seq } = coordinates(fields)
      const target = parseTarget(fields['target'])
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined) throw new RouteError(404, 'The session is not loaded.')
      if (!this.settings.revertWhileRunning && agent.status === 'running') {
        throw new RouteError(409, 'The agent is working. Revert when it finishes, or stop it first.')
      }
      if (this.busy.has(sessionId)) throw new RouteError(409, 'Another revert is running in this session.')
      this.busy.add(sessionId)
      try {
        const signal = AbortSignal.any([request.signal, this.lifetime.signal])
        const before = await reviewOf(sessionId, seq, signal)
        const run = await reviewer.revert(sessionId, seq, selectHunks(before, target), signal)
        if (run === undefined) throw new RouteError(404, 'This turn\'s changes are no longer available on the server.')
        const kept = this.keptHunks(sessionId, seq)
        for (const result of run.results) if (result.outcome === 'reverted') kept.delete(`${result.index}:${result.hunk}`)
        let notified = false
        if (run.reverted.length > 0) {
          const source: HunkReviewMessageSource = {
            kind: 'hunk-review',
            seq,
            turn: before.turn,
            files: run.reverted.map(file => ({
              path: file.path,
              hunks: run.results.filter(result => result.outcome === 'reverted' && before.files.find(entry => entry.index === result.index)?.path === file.path).map(result => result.hunk),
            })),
          }
          try {
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: frameReverts(before.turn, run.reverted, this.settings.messageMaxBytes) }],
              source,
            }))
            notified = true
          } catch (error: unknown) {
            this.ctx.logger.warn(`hunk-review: the note about reverted hunks was not queued for the agent: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const answer: RevertResponse = { results: run.results, notified, review: await reviewOf(sessionId, seq, signal) }
        return json(answer)
      } finally {
        this.busy.delete(sessionId)
      }
    })
  }
}

export default HunkReviewService
