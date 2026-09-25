/** The text of the user message that tells the agent which of its hunks the user reverted. */

/** One reverted hunk as the agent sees it. */
export interface RevertedHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** Reverted hunks of one file. */
export interface RevertedFile {
  readonly path: string
  readonly hunks: readonly RevertedHunk[]
}

const FRAME_TAGS = /<(\/?)(reverted_changes|file)\b/g

/**
 * Keep hunk text from closing the frame early.
 * @param text - one line.
 * @returns the line with frame tags written as `&lt;…`.
 */
export function escapeFramed(text: string): string {
  return text.replace(FRAME_TAGS, '&lt;$1$2')
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Frame reverted hunks for the model.
 * @param turn - the reviewed turn.
 * @param files - reverted hunks by file, in file order.
 * @param maxBytes - UTF-8 budget of the hunk bodies; later lines are replaced by one omission line.
 * @returns the message text.
 */
export function frameReverts(turn: number, files: readonly RevertedFile[], maxBytes: number): string {
  const count = files.reduce((sum, file) => sum + file.hunks.length, 0)
  const out: string[] = [
    `The user reviewed the file changes you made in turn ${turn} and reverted ${count === 1 ? 'the hunk' : `${count} hunks`} below. `
    + 'These changes are no longer in the files: each file now has the lines marked "-" where it had the lines marked "+". '
    + 'Do not reapply them unless the user asks; read a file again before editing it.',
    '<reverted_changes>',
  ]
  let used = 0
  let omitted = 0
  for (const file of files) {
    out.push(`<file path="${attribute(file.path)}">`)
    for (const hunk of file.hunks) {
      const body = [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines.map(escapeFramed)]
      for (const line of body) {
        const size = Buffer.byteLength(line, 'utf8') + 1
        if (omitted > 0 || used + size > maxBytes) {
          omitted += 1
          continue
        }
        used += size
        out.push(line)
      }
    }
    out.push('</file>')
  }
  if (omitted > 0) out.push(`[${omitted} more lines of the reverted hunks omitted]`)
  out.push('</reverted_changes>')
  return out.join('\n')
}
