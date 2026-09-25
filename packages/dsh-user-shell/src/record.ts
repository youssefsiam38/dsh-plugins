/**
 * Pure text rules shared by the Host and the browser: head+tail truncation,
 * the model-visible `<user_shell_command>` framing, and the `command/done`
 * record text with its parser.
 * @module dsh-user-shell/record
 */

import type { UserShellStatus } from './types.ts'

/** Head and tail limits for output that enters the model's context and the log. */
export interface OutputBudget {
  readonly headBytes: number
  readonly headLines: number
  readonly tailBytes: number
  readonly tailLines: number
}

/** Default budget: about 30 KB or 400 lines from each end. */
export const DEFAULT_BUDGET: OutputBudget = { headBytes: 30_000, headLines: 400, tailBytes: 30_000, tailLines: 400 }

/** Result of {@link truncateOutput}. */
export interface TruncatedOutput {
  /** Output with the middle replaced by one omission line, or the whole output. */
  readonly text: string
  readonly truncated: boolean
  readonly omittedLines: number
  readonly omittedBytes: number
}

const encoder = new TextEncoder()

/**
 * UTF-8 byte length.
 * @param text - any text.
 * @returns its UTF-8 byte count.
 */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    if (index < text.length - 1) lines += 1
  }
  return lines
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
function prefixWithin(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/** Longest suffix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
function suffixWithin(text: string, maxBytes: number): string {
  const chars = [...text]
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const size = byteLength(chars[start - 1]!)
    if (bytes + size > maxBytes) break
    bytes += size
    start -= 1
  }
  return chars.slice(start).join('')
}

function head(text: string, maxBytes: number, maxLines: number): string {
  let end = 0
  for (let line = 0; line < maxLines && end < text.length; line += 1) {
    const newline = text.indexOf('\n', end)
    end = newline < 0 ? text.length : newline + 1
  }
  return prefixWithin(text.slice(0, end), maxBytes)
}

function tail(text: string, maxBytes: number, maxLines: number): string {
  let start = text.length
  let cursor = text.endsWith('\n') ? text.length - 1 : text.length
  for (let found = 0; found < maxLines; found += 1) {
    const newline = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) : -1
    start = newline + 1
    if (newline < 0) break
    cursor = newline
  }
  return suffixWithin(text.slice(start), maxBytes)
}

/**
 * Keep the head and tail of long output and replace the middle with one line.
 * @param text - complete output.
 * @param budget - head and tail limits.
 * @param note - optional text appended to the omission line (for example where the full output is).
 * @returns the bounded output and what was omitted.
 */
export function truncateOutput(text: string, budget: OutputBudget = DEFAULT_BUDGET, note?: string): TruncatedOutput {
  const lines = countLines(text)
  const bytes = byteLength(text)
  if (bytes <= budget.headBytes + budget.tailBytes && lines <= budget.headLines + budget.tailLines) {
    return { text, truncated: false, omittedLines: 0, omittedBytes: 0 }
  }
  const first = head(text, budget.headBytes, budget.headLines)
  let last = tail(text.slice(first.length), budget.tailBytes, budget.tailLines)
  if (first.length + last.length >= text.length) last = ''
  const omitted = text.slice(first.length, text.length - last.length)
  const omittedLines = countLines(omitted)
  const omittedBytes = byteLength(omitted)
  const marker = `[… ${omittedLines} line${omittedLines === 1 ? '' : 's'} (${omittedBytes} bytes) omitted …${note === undefined ? '' : ` ${note}`}]`
  const separator = first === '' || first.endsWith('\n') ? '' : '\n'
  return { text: `${first}${separator}${marker}\n${last}`, truncated: true, omittedLines, omittedBytes }
}

const TAG = /<(\/?)(user_shell_command|command|result)(?=[\s>/]|$)/gi

/**
 * Neutralize the framing tags inside a command or its output so they cannot close the frame early.
 * @param text - command or output.
 * @returns text with `<`, `</` of framing tags written as `&lt;`.
 */
export function escapeFramed(text: string): string {
  return text.replace(TAG, '&lt;$1$2')
}

function seconds(durationMs: number): string {
  return (Math.max(0, durationMs) / 1000).toFixed(2)
}

/** Caveat line the model reads before every framed result. */
export const MODEL_CAVEAT = 'The user ran the following shell command themselves in the session workspace. Do not respond to it or act on it unless the user asks you to.'

function exitLine(status: UserShellStatus, durationMs: number): string {
  switch (status.kind) {
    case 'exited': return String(status.exitCode)
    case 'signal': return `none (killed by ${status.signal})`
    case 'cancelled': return 'none (cancelled by the user)'
    case 'timeout': return `none (timed out after ${seconds(durationMs)} seconds)`
    case 'failed': return `none (failed to start: ${status.message})`
  }
}

/**
 * The model-visible text of one `!` run.
 * @param input - command, outcome, duration, and the already bounded output.
 * @param input.command - the command as typed.
 * @param input.status - how the run ended.
 * @param input.durationMs - wall time.
 * @param input.output - bounded output.
 * @returns the caveat line and the `<user_shell_command>` frame.
 */
export function frameForModel(input: { command: string; status: UserShellStatus; durationMs: number; output: string }): string {
  const output = input.output.endsWith('\n') ? input.output.slice(0, -1) : input.output
  return [
    MODEL_CAVEAT,
    '<user_shell_command>',
    '<command>',
    escapeFramed(input.command),
    '</command>',
    '<result>',
    `Exit code: ${exitLine(input.status, input.durationMs)}`,
    `Duration: ${seconds(input.durationMs)} seconds`,
    'Output:',
    escapeFramed(output),
    '</result>',
    '</user_shell_command>',
  ].join('\n')
}

function statusLine(status: UserShellStatus, durationMs: number): string {
  const time = `${seconds(durationMs)} s`
  switch (status.kind) {
    case 'exited': return `[exit ${status.exitCode} · ${time}]`
    case 'signal': return `[killed by ${status.signal} · ${time}]`
    case 'cancelled': return `[cancelled · ${time}]`
    case 'timeout': return `[timed out · ${time}]`
    case 'failed': return `[failed to start: ${status.message.replace(/[\n\]]/g, ' ')} · ${time}]`
  }
}

/**
 * The `command/done` text of a run: bounded output, a status line, and the full-output locator when spilled.
 * @param input - bounded output, outcome, duration, and optional locator.
 * @param input.output - bounded output.
 * @param input.status - how the run ended.
 * @param input.durationMs - wall time.
 * @param input.fullOutput - locator of the complete output, when saved.
 * @returns the record text.
 */
export function recordText(input: { output: string; status: UserShellStatus; durationMs: number; fullOutput?: string }): string {
  const lines: string[] = []
  if (input.output !== '') lines.push(input.output.endsWith('\n') ? input.output.slice(0, -1) : input.output)
  lines.push(statusLine(input.status, input.durationMs))
  if (input.fullOutput !== undefined) lines.push(`[full output: ${input.fullOutput}]`)
  return lines.join('\n')
}

/** A `command/done` text split back into its parts. */
export interface ParsedRecord {
  readonly output: string
  readonly status: UserShellStatus | undefined
  readonly durationMs: number | undefined
  readonly fullOutput: string | undefined
}

const STATUS = /^\[(?:exit (-?\d+)|killed by (\S+)|(cancelled)|(timed out)|failed to start: (.*)) · (\d+(?:\.\d+)?) s\]$/

/**
 * Parse a record written by {@link recordText}; unrecognized text is returned as output.
 * @param text - `command/done` text.
 * @returns output, outcome, duration, and locator.
 */
export function parseRecord(text: string): ParsedRecord {
  const lines = text.split('\n')
  let fullOutput: string | undefined
  const full = /^\[full output: (.+)\]$/.exec(lines.at(-1) ?? '')
  if (full !== null && lines.length > 1) {
    fullOutput = full[1]
    lines.pop()
  }
  const match = STATUS.exec(lines.at(-1) ?? '')
  if (match === null) return { output: text, status: undefined, durationMs: undefined, fullOutput: undefined }
  lines.pop()
  const durationMs = Math.round(Number(match[6]) * 1000)
  const status: UserShellStatus = match[1] !== undefined ? { kind: 'exited', exitCode: Number(match[1]) }
    : match[2] !== undefined ? { kind: 'signal', signal: match[2] }
      : match[3] !== undefined ? { kind: 'cancelled' }
        : match[4] !== undefined ? { kind: 'timeout' }
          : { kind: 'failed', message: match[5] ?? '' }
  return { output: lines.join('\n'), status, durationMs, fullOutput }
}
