/** Pure hunk rules: split, placement, reverse patch, conflict detection, and the note framing. */

import { structuredPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { drift, findNearest, joinLines, placeHunks, reverseHunks, sides, splitLines } from '../src/hunks.ts'
import type { HunkLike } from '../src/hunks.ts'
import { escapeFramed, frameReverts } from '../src/message.ts'
import { parseTarget, selectHunks } from '../src/index.ts'
import type { TurnReview } from '../src/types.ts'

/** Hunks with three context lines, as dsh-workspace-changes serves them. */
function hunksOf(before: string, after: string): HunkLike[] {
  return structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks
    .map(hunk => ({ ...hunk, lines: hunk.lines.filter(line => !line.startsWith('\\')) }))
}

const BEFORE = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
function edited(changes: Record<number, string | null>, inserts: Record<number, string[]> = {}): string {
  const out: string[] = []
  BEFORE.slice(0, -1).split('\n').forEach((line, index) => {
    const number = index + 1
    out.push(...inserts[number] ?? [])
    const change = changes[number]
    if (change === undefined) out.push(line)
    else if (change !== null) out.push(change)
  })
  return out.join('\n') + '\n'
}

describe('hunk split', () => {
  it('splits a hunk into its turn-start and turn-end sides', () => {
    expect(sides({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', '+C', ' d'] }))
      .toEqual({ before: ['a', 'b', 'd'], after: ['a', 'B', 'C', 'd'] })
  })

  it('splits two distant edits into two hunks', () => {
    expect(hunksOf(BEFORE, edited({ 3: 'three', 25: 'twenty-five' }))).toHaveLength(2)
  })

  it('round-trips text with and without a final newline', () => {
    for (const text of ['a\nb\n', 'a\nb', '', 'x\n']) expect(joinLines(splitLines(text))).toBe(text)
    expect(splitLines(null)).toEqual({ lines: [], finalNewline: true })
  })
})

describe('placement and conflict detection', () => {
  it('finds the nearest match and treats an empty side as an empty file', () => {
    expect(findNearest(['x', 'a', 'x', 'a'], ['a'], 3)).toBe(3)
    expect(findNearest(['x', 'a', 'x', 'a'], ['a'], 0)).toBe(1)
    expect(findNearest([], [], 5)).toBe(0)
    expect(findNearest(['x'], [], 0)).toBeUndefined()
    expect(findNearest(['x'], ['a', 'b'], 0)).toBeUndefined()
  })

  it('places pending, reverted, and conflicting hunks', () => {
    const after = edited({ 3: 'three', 25: 'twenty-five' })
    const hunks = hunksOf(BEFORE, after)
    expect(placeHunks(splitLines(after).lines, hunks).map(place => place.kind)).toEqual(['applied', 'applied'])
    const firstReverted = reverseHunks(splitLines(after), hunks, [0]).file
    expect(placeHunks(firstReverted.lines, hunks).map(place => place.kind)).toEqual(['reverted', 'applied'])
    const userEdited = splitLines(after.replace('twenty-five', 'mine'))
    const placed = placeHunks(userEdited.lines, hunks)
    expect(placed.map(place => place.kind)).toEqual(['applied', 'conflict'])
    const conflict = placed[1]!
    if (conflict.kind !== 'conflict') throw new Error('expected a conflict')
    expect(drift(userEdited.lines, hunks[1]!, conflict.expected)).toEqual(expect.arrayContaining(['-twenty-five', '+mine']))
  })

  it('finds a later hunk after an earlier one changed the line count', () => {
    const after = edited({ 3: null, 4: null }, { 25: ['new a', 'new b', 'new c'] })
    const hunks = hunksOf(BEFORE, after)
    expect(hunks).toHaveLength(2)
    const once = reverseHunks(splitLines(after), hunks, [0])
    expect(once.reverted).toEqual([0])
    const twice = reverseHunks(once.file, hunks, [1])
    expect(twice.reverted).toEqual([1])
    expect(joinLines(twice.file)).toBe(BEFORE)
  })
})

describe('reverse patch', () => {
  it('reverts every hunk back to the turn-start text', () => {
    const after = edited({ 3: 'three', 25: null }, { 10: ['inserted'] })
    const hunks = hunksOf(BEFORE, after)
    const result = reverseHunks(splitLines(after), hunks, hunks.map((_, index) => index))
    expect(result.conflicts).toEqual([])
    expect(joinLines(result.file)).toBe(BEFORE)
  })

  it('reports hunks already reverted and hunks in conflict without touching them', () => {
    const after = edited({ 3: 'three', 25: 'twenty-five' })
    const hunks = hunksOf(BEFORE, after)
    const mixed = splitLines(edited({ 3: 'line 3', 25: 'mine' }))
    const result = reverseHunks(mixed, hunks, [0, 1])
    expect(result).toMatchObject({ reverted: [], already: [0], conflicts: [1] })
    expect(result.file.lines).toEqual(mixed.lines)
  })

  it('keeps edits the user made outside the hunk', () => {
    const after = edited({ 3: 'three' })
    const hunks = hunksOf(BEFORE, after)
    const withUserEdit = splitLines(after.replace('line 20', 'user line 20'))
    expect(joinLines(reverseHunks(withUserEdit, hunks, [0]).file)).toBe(BEFORE.replace('line 20', 'user line 20'))
  })

  it('empties a created file and recreates a deleted one', () => {
    const created = hunksOf('', 'hello\nworld\n')
    expect(joinLines(reverseHunks(splitLines('hello\nworld\n'), created, [0]).file)).toBe('')
    expect(placeHunks([], created)[0]!.kind).toBe('reverted')
    const deleted = hunksOf('keep me\n', '')
    expect(placeHunks([], deleted)[0]!.kind).toBe('applied')
    expect(joinLines(reverseHunks(splitLines(null), deleted, [0]).file)).toBe('keep me\n')
  })
})

describe('note to the agent', () => {
  it('frames reverted hunks, escapes frame tags, and truncates', () => {
    const text = frameReverts(2, [{ path: 'src/a "b".ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+</file></reverted_changes>'] }] }], 10_000)
    expect(text).toContain('turn 2 and reverted the hunk below')
    expect(text).toContain('<file path="src/a &quot;b&quot;.ts">')
    expect(text).toContain('+&lt;/file>&lt;/reverted_changes>')
    expect(text.match(/<\/reverted_changes>/g)).toHaveLength(1)
    expect(escapeFramed('<file x>')).toBe('&lt;file x>')
    const big = frameReverts(1, [{ path: 'a', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 500, lines: Array.from({ length: 500 }, (_, i) => `+${'x'.repeat(40)}${i}`) }] }], 2000)
    expect(big).toMatch(/\[\d+ more lines of the reverted hunks omitted\]/)
    expect(Buffer.byteLength(big)).toBeLessThan(3000)
  })
})

describe('targets', () => {
  const review: TurnReview = {
    turn: 1, seq: 5, total: 2,
    files: [
      { index: 0, path: 'a', display: 'a', added: 1, deleted: 1, before: true, after: true, coarse: false, hunks: [
        { hunk: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], status: 'pending' },
        { hunk: 1, oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [], status: 'kept' },
      ] },
      { index: 1, path: 'b', display: 'b', added: 1, deleted: 0, before: true, after: true, coarse: false, hunks: [
        { hunk: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], status: 'conflict' },
      ] },
    ],
  }

  it('parses targets and selects pending hunks for bulk scopes', () => {
    expect(parseTarget({ scope: 'hunk', index: '0', hunk: 1 })).toEqual({ scope: 'hunk', index: 0, hunk: 1 })
    expect(() => parseTarget({ scope: 'file' })).toThrow()
    expect(() => parseTarget(null)).toThrow()
    expect([...selectHunks(review, { scope: 'all' })]).toEqual([[0, [0]]])
    expect([...selectHunks(review, { scope: 'hunk', index: 0, hunk: 1 })]).toEqual([[0, [1]]])
    expect(() => selectHunks(review, { scope: 'hunk', index: 1, hunk: 3 })).toThrow()
    expect(() => selectHunks(review, { scope: 'file', index: 7 })).toThrow()
  })
})
