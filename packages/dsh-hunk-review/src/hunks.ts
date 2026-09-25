/**
 * Pure hunk rules: split a comparison hunk into its turn-start and turn-end
 * sides, find where each hunk stands in the file now, and build the reverse
 * patch that puts turn-start lines back for a chosen set of hunks.
 *
 * Lines compare exactly. A hunk's side is searched outward from its expected
 * line, which moves by the size difference of every earlier hunk of the file
 * that is currently reverted, so an earlier revert does not hide a later hunk.
 */

import { diffArrays } from 'diff'

/** The hunk fields these rules read (the `WorkspaceDiffHunk` of dsh-workspace-changes). */
export interface HunkLike {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** A file's text as lines plus whether it ends with a newline. */
export interface FileLines {
  readonly lines: readonly string[]
  readonly finalNewline: boolean
}

/** Where one hunk stands in the current lines. */
export type Placement =
  | { readonly kind: 'applied'; readonly at: number }
  | { readonly kind: 'reverted'; readonly at: number }
  | { readonly kind: 'conflict'; readonly expected: number }

/**
 * Split a hunk into its turn-start side (context and `-` lines) and turn-end side (context and `+` lines).
 * @param hunk - the hunk.
 * @returns both sides without prefixes.
 */
export function sides(hunk: HunkLike): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  for (const line of hunk.lines) {
    const body = line.slice(1)
    if (line.startsWith('-')) before.push(body)
    else if (line.startsWith('+')) after.push(body)
    else {
      before.push(body)
      after.push(body)
    }
  }
  return { before, after }
}

/**
 * Split file text into lines. `null` (a missing file) and `''` have no lines.
 * @param text - file text, or null when the file does not exist.
 * @returns the lines and whether the text ended with a newline.
 */
export function splitLines(text: string | null): FileLines {
  if (text === null || text === '') return { lines: [], finalNewline: true }
  const finalNewline = text.endsWith('\n')
  return { lines: (finalNewline ? text.slice(0, -1) : text).split('\n'), finalNewline }
}

/**
 * Join lines back into file text.
 * @param file - lines and final-newline flag.
 * @returns the text; no lines give `''`.
 */
export function joinLines(file: FileLines): string {
  return file.lines.length === 0 ? '' : `${file.lines.join('\n')}${file.finalNewline ? '\n' : ''}`
}

function matchesAt(lines: readonly string[], side: readonly string[], at: number): boolean {
  if (at < 0 || at + side.length > lines.length) return false
  for (let offset = 0; offset < side.length; offset += 1) {
    if (lines[at + offset] !== side[offset]) return false
  }
  return true
}

/**
 * Find a side's start line nearest to an expected line.
 * @param lines - current lines.
 * @param side - the lines to find; an empty side matches only an empty file.
 * @param expected - 0-based line where the side is expected.
 * @returns the 0-based start, or undefined.
 */
export function findNearest(lines: readonly string[], side: readonly string[], expected: number): number | undefined {
  if (side.length === 0) return lines.length === 0 ? 0 : undefined
  const last = lines.length - side.length
  if (last < 0) return undefined
  const start = Math.min(Math.max(expected, 0), last)
  for (let distance = 0; distance <= last; distance += 1) {
    const below = start + distance
    const above = start - distance
    if (below > last && above < 0) break
    if (below <= last && matchesAt(lines, side, below)) return below
    if (distance > 0 && above >= 0 && matchesAt(lines, side, above)) return above
  }
  return undefined
}

/**
 * Place every hunk of one file against its current lines.
 * @param lines - current lines (none for a missing file).
 * @param hunks - the file's hunks in file order.
 * @returns one placement per hunk.
 */
export function placeHunks(lines: readonly string[], hunks: readonly HunkLike[]): Placement[] {
  let shift = 0
  return hunks.map((hunk) => {
    const { before, after } = sides(hunk)
    const expectedAfter = Math.max(hunk.newStart - 1, 0) + shift
    const applied = findNearest(lines, after, expectedAfter)
    if (applied !== undefined) return { kind: 'applied', at: applied }
    const reverted = findNearest(lines, before, expectedAfter)
    if (reverted !== undefined) {
      shift += before.length - after.length
      return { kind: 'reverted', at: reverted }
    }
    return { kind: 'conflict', expected: expectedAfter }
  })
}

/**
 * Describe how the file differs from a conflicting hunk's turn-end lines at its expected place.
 * @param lines - current lines.
 * @param hunk - the conflicting hunk.
 * @param expected - 0-based expected start.
 * @returns prefixed lines: `-` turn end, `+` file now, space both.
 */
export function drift(lines: readonly string[], hunk: HunkLike, expected: number): string[] {
  const { after } = sides(hunk)
  const start = Math.min(Math.max(expected, 0), lines.length)
  const current = lines.slice(start, start + Math.max(after.length, 1))
  const out: string[] = []
  for (const part of diffArrays(after, current)) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' '
    for (const line of part.value) out.push(`${prefix}${line}`)
  }
  return out
}

/** Result of {@link reverseHunks}. */
export interface ReverseResult {
  /** The file's new lines. */
  readonly file: FileLines
  /** Hunk indexes reverted by the new lines. */
  readonly reverted: readonly number[]
  /** Hunk indexes already at their turn-start lines. */
  readonly already: readonly number[]
  /** Hunk indexes whose turn-end lines were not found, or overlap another chosen hunk. */
  readonly conflicts: readonly number[]
}

/**
 * Apply the reverse patch of chosen hunks: each chosen hunk whose turn-end
 * lines are in the file gets its turn-start lines back. Other hunks and
 * other lines are left as they are.
 * @param file - current lines.
 * @param hunks - the file's hunks in file order.
 * @param chosen - hunk indexes to revert.
 * @returns the new lines and the outcome of each chosen hunk.
 */
export function reverseHunks(file: FileLines, hunks: readonly HunkLike[], chosen: readonly number[]): ReverseResult {
  const placements = placeHunks(file.lines, hunks)
  const wanted = [...new Set(chosen)].filter(index => index >= 0 && index < hunks.length).sort((a, b) => a - b)
  const already: number[] = []
  const conflicts: number[] = []
  const edits: { index: number; at: number; length: number; replacement: string[] }[] = []
  let end = -1
  for (const index of wanted) {
    const placement = placements[index]!
    if (placement.kind === 'reverted') {
      already.push(index)
      continue
    }
    if (placement.kind === 'conflict') {
      conflicts.push(index)
      continue
    }
    const { before, after } = sides(hunks[index]!)
    // Chosen hunks are placed in file order; one that starts inside the previous edit overlaps it.
    if (placement.at < end || (after.length === 0 && placement.at === end && edits.length > 0)) {
      conflicts.push(index)
      continue
    }
    edits.push({ index, at: placement.at, length: after.length, replacement: before })
    end = placement.at + after.length
  }
  const lines = [...file.lines]
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) lines.splice(edit.at, edit.length, ...edit.replacement)
  // A file that had no lines gets a final newline when lines come back.
  const finalNewline = file.lines.length === 0 ? true : file.finalNewline
  return { file: { lines, finalNewline }, reverted: edits.map(edit => edit.index), already, conflicts }
}
