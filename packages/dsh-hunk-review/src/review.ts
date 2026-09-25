/**
 * Turn review against the file service: reads a turn's comparisons from
 * `ctx.workspaceChanges`, places each hunk in the file as it is now, and
 * reverts chosen hunks with one version-guarded write per file.
 */

import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChanges, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes'
import { drift, joinLines, placeHunks, reverseHunks, splitLines } from './hunks.ts'
import type { FileLines } from './hunks.ts'
import type { RevertedFile } from './message.ts'
import type { HunkStatus, ReviewFile, ReviewHunk, RevertOutcome, TurnReview } from './types.ts'

/** Bounds of a review. */
export interface ReviewLimits {
  /** Files reviewed per turn; later files are counted in `total` only. */
  readonly maxFiles: number
  /** Largest file read for placement, in bytes. */
  readonly maxFileBytes: number
}

/** The file service operations a review uses. */
export type ReviewFs = Pick<FileSystem, 'resolve' | 'stat' | 'readText' | 'writeText'>

/** A file as it is now, with the version a revert write is guarded by. */
interface Current {
  readonly target: FsTarget
  /** Undefined when the file does not exist. */
  readonly version: FsVersion | undefined
  readonly file: FileLines
}

/** Result of one revert request. */
export interface RevertRun {
  readonly results: RevertOutcome[]
  /** Reverted hunks by file, for the agent's note. */
  readonly reverted: RevertedFile[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Reads and reverts one Session's turn changes. */
export class TurnReviewer {
  /**
   * @param fs - the file service of the Session's execution world.
   * @param changes - the recorded turn changes.
   * @param limits - review bounds.
   */
  constructor(
    private readonly fs: ReviewFs,
    private readonly changes: WorkspaceChanges,
    private readonly limits: ReviewLimits,
  ) {}

  /**
   * The recorded summary of one turn.
   * @param sessionId - Session.
   * @param seq - the `workspace/changes` event sequence.
   * @returns the summary, or undefined when the Host no longer serves it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined {
    return this.changes.summary(sessionId, seq)
  }

  /**
   * Review one turn against the files as they are now.
   * @param sessionId - Session.
   * @param seq - the `workspace/changes` event sequence.
   * @param kept - keys (`index:hunk`) of hunks the user kept.
   * @param signal - cancels the reads.
   * @returns the review, or undefined when the Host no longer serves the turn.
   */
  async review(sessionId: SessionId, seq: number, kept: ReadonlySet<string>, signal: AbortSignal): Promise<TurnReview | undefined> {
    const summary = this.changes.summary(sessionId, seq)
    if (summary === undefined) return undefined
    const files: ReviewFile[] = []
    const count = Math.min(summary.files.length, this.limits.maxFiles)
    for (let index = 0; index < count; index += 1) {
      files.push(await this.reviewFile(sessionId, seq, summary, index, kept, signal))
    }
    return { turn: summary.turn, seq, files, total: summary.total }
  }

  private async reviewFile(sessionId: SessionId, seq: number, summary: WorkspaceChangesSummary, index: number, kept: ReadonlySet<string>, signal: AbortSignal): Promise<ReviewFile> {
    const listed = summary.files[index]!
    const base = { index, path: listed.path, display: listed.display, added: listed.added, deleted: listed.deleted }
    const diff = await this.changes.diff(sessionId, seq, index, signal)
    if (diff === undefined) return { ...base, before: true, after: true, coarse: false, hunks: [], unreviewable: 'unavailable' }
    if (diff.kind !== 'text') return { ...base, before: true, after: true, coarse: false, hunks: [], unreviewable: diff.kind }
    const shape = { ...base, before: diff.before, after: diff.after, coarse: diff.coarse }
    let current: Current
    try {
      current = await this.current(summary.cwd, diff.path, signal)
    } catch (error: unknown) {
      if (errorCode(error) === 'FS_TOO_LARGE') return { ...shape, hunks: [], unreviewable: 'oversized' }
      return { ...shape, hunks: [], unreviewable: 'unreadable', message: errorMessage(error) }
    }
    return { ...shape, hunks: this.place(index, diff.hunks, current.file.lines, kept) }
  }

  private place(index: number, hunks: readonly WorkspaceDiffHunk[], lines: readonly string[], kept: ReadonlySet<string>): ReviewHunk[] {
    return placeHunks(lines, hunks).map((placement, at) => {
      const hunk = hunks[at]!
      const record = { hunk: at, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines }
      if (placement.kind === 'conflict') return { ...record, status: 'conflict', drift: drift(lines, hunk, placement.expected) }
      const status: HunkStatus = placement.kind === 'reverted' ? 'reverted' : kept.has(`${index}:${at}`) ? 'kept' : 'pending'
      return { ...record, status }
    })
  }

  private async current(cwd: string, path: string, signal: AbortSignal): Promise<Current> {
    const target = await this.fs.resolve(path, { cwd, signal })
    const info = await this.fs.stat(target, signal)
    if (info === undefined) return { target, version: undefined, file: splitLines(null) }
    if (info.type !== 'file') throw new Error(`${target.displayPath} is not a regular file.`)
    if (info.size !== undefined && info.size > this.limits.maxFileBytes) throw Object.assign(new Error('The file is too large to review.'), { code: 'FS_TOO_LARGE' })
    const text = await this.fs.readText(target, signal)
    return { target, version: info.version, file: splitLines(text) }
  }

  /**
   * Revert chosen hunks: per file, read the file, apply the reverse patch of
   * the chosen hunks whose turn-end lines are still there, and write it back
   * only if the file did not change since the read.
   * @param sessionId - Session.
   * @param seq - the `workspace/changes` event sequence.
   * @param chosen - hunk indexes by file index.
   * @param signal - cancels the reads and the writes.
   * @returns the outcome of every chosen hunk, or undefined when the Host no longer serves the turn.
   */
  async revert(sessionId: SessionId, seq: number, chosen: ReadonlyMap<number, readonly number[]>, signal: AbortSignal): Promise<RevertRun | undefined> {
    const summary = this.changes.summary(sessionId, seq)
    if (summary === undefined) return undefined
    const results: RevertOutcome[] = []
    const reverted: RevertedFile[] = []
    for (const [index, hunkIndexes] of [...chosen].sort(([a], [b]) => a - b)) {
      const fail = (reason: string): void => {
        for (const hunk of hunkIndexes) results.push({ index, hunk, outcome: 'failed', reason })
      }
      if (summary.files[index] === undefined || index >= this.limits.maxFiles) {
        fail('The file is not part of this review.')
        continue
      }
      let diff: WorkspaceFileDiff | undefined
      try {
        diff = await this.changes.diff(sessionId, seq, index, signal)
      } catch (error: unknown) {
        fail(errorMessage(error))
        continue
      }
      if (diff?.kind !== 'text') {
        fail('The file has no line comparison to revert.')
        continue
      }
      let current: Current
      try {
        current = await this.current(summary.cwd, diff.path, signal)
      } catch (error: unknown) {
        fail(errorMessage(error))
        continue
      }
      const outcome = reverseHunks(current.file, diff.hunks, hunkIndexes)
      for (const hunk of outcome.already) results.push({ index, hunk, outcome: 'already' })
      for (const hunk of outcome.conflicts) results.push({ index, hunk, outcome: 'conflict' })
      if (outcome.reverted.length === 0) continue
      try {
        await this.fs.writeText(
          current.target,
          joinLines(outcome.file),
          current.version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current.version },
          signal,
        )
      } catch (error: unknown) {
        const code = errorCode(error)
        const changed = code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED'
        for (const hunk of outcome.reverted) {
          results.push(changed
            ? { index, hunk, outcome: 'conflict', reason: 'The file changed while it was being reverted.' }
            : { index, hunk, outcome: 'failed', reason: errorMessage(error) })
        }
        continue
      }
      for (const hunk of outcome.reverted) results.push({ index, hunk, outcome: 'reverted' })
      reverted.push({ path: diff.path, hunks: outcome.reverted.map(hunk => diff.hunks[hunk]!) })
    }
    return { results, reverted }
  }
}
