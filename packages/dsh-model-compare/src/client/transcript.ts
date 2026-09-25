/**
 * Pure fold of a lane's event window into the compact transcript the lane
 * column shows: what happened after the fork-inherited prefix (after the last
 * `session/end-seed` marker), with streaming text from transient live chunks
 * until the settled `assistant/message` replaces them.
 *
 * The stock Chat view cannot be embedded here: its `conversation.session`
 * and `conversation.content` seats are declared by the Conversation content
 * this view already renders inside, and a Factory cannot render itself
 * recursively.
 */

/** One event-window entry, as the session client exposes it (read structurally). */
export interface WindowEntry {
  readonly type: 'event' | 'transient'
  readonly event: { readonly type: string; readonly seq: number; readonly data: unknown }
}

/** One transcript item. */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly key: string; readonly text: string }
  | { readonly kind: 'answer'; readonly key: string; readonly text: string; readonly reasoning: string; readonly streaming: boolean }
  | { readonly kind: 'tool'; readonly key: string; readonly name: string; readonly error: string | undefined; readonly done: boolean }
  | { readonly kind: 'error'; readonly key: string; readonly text: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function blocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  const out: Array<Record<string, unknown>> = []
  for (const block of value as unknown[]) {
    const fields = record(block)
    if (fields !== undefined) out.push(fields)
  }
  return out
}

function textOf(content: unknown, type: 'text' | 'reasoning'): string {
  return blocks(content).filter(block => block['type'] === type && typeof block['text'] === 'string').map(block => block['text'] as string).join('\n\n')
}

/**
 * Fold a window.
 * @param entries - the lane's event window, oldest first.
 * @param skipFirstPrompt - drop the first human message (the comparison prompt, shown above the columns).
 * @returns transcript items, oldest first.
 */
export function foldTranscript(entries: readonly WindowEntry[], skipFirstPrompt = true): TranscriptItem[] {
  let start = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.event.type === 'session/end-seed') {
      start = index + 1
      break
    }
  }
  const items: TranscriptItem[] = []
  const tools = new Map<string, number>()
  const live = new Map<string, { index: number; text: string[]; reasoning: string[] }>()
  let skipped = !skipFirstPrompt
  for (const entry of entries.slice(start)) {
    const { event } = entry
    const data = record(event.data)
    if (data === undefined) continue
    if (entry.type === 'transient') {
      const attempt = String(data['attemptId'])
      const chunk = record(data['chunk'])
      if (chunk === undefined) continue
      let stream = live.get(attempt)
      if (stream === undefined) {
        stream = { index: items.length, text: [], reasoning: [] }
        live.set(attempt, stream)
        items.push({ kind: 'answer', key: `live-${attempt}`, text: '', reasoning: '', streaming: true })
      }
      if (chunk['type'] === 'text-delta' && typeof chunk['text'] === 'string') stream.text.push(chunk['text'])
      if (chunk['type'] === 'reasoning-delta' && typeof chunk['text'] === 'string') stream.reasoning.push(chunk['text'])
      items[stream.index] = { kind: 'answer', key: `live-${attempt}`, text: stream.text.join(''), reasoning: stream.reasoning.join(''), streaming: true }
      continue
    }
    switch (event.type) {
      case 'user/message': {
        const source = record(data['source'])
        if (source?.['kind'] !== 'user') break
        if (!skipped) {
          skipped = true
          break
        }
        items.push({ kind: 'user', key: `e${event.seq}`, text: textOf(data['content'], 'text') })
        break
      }
      case 'assistant/message': {
        const message = record(data['message'])
        const text = textOf(message?.['content'], 'text')
        const reasoning = textOf(message?.['content'], 'reasoning')
        if (text !== '' || reasoning !== '') items.push({ kind: 'answer', key: `e${event.seq}`, text, reasoning, streaming: false })
        break
      }
      case 'tool/call': {
        const callId = String(data['callId'])
        tools.set(callId, items.length)
        items.push({ kind: 'tool', key: `e${event.seq}`, name: typeof data['name'] === 'string' ? data['name'] : '?', error: undefined, done: false })
        break
      }
      case 'tool/result': {
        const message = record(data['message'])
        const callId = String(message?.['toolCallId'] ?? data['callId'])
        const at = tools.get(callId)
        const error = record(data['error'])
        const failed = error !== undefined || message?.['isError'] === true
        const reason = failed ? (textOf(message?.['content'], 'text') || String(error?.['reason'] ?? error?.['code'] ?? '')) : undefined
        if (at !== undefined) {
          const item = items[at]
          if (item?.kind === 'tool') items[at] = { ...item, error: reason, done: true }
        }
        break
      }
      case 'turn/end': {
        const reason = record(data['reason'])
        const error = record(reason?.['error'])
        if (reason?.['kind'] === 'error' && typeof error?.['message'] === 'string') items.push({ kind: 'error', key: `e${event.seq}`, text: error['message'] })
        break
      }
      default:
        break
    }
  }
  // A settled attempt leaves its transient chunks only until the window replaces them.
  return items.filter(item => item.kind !== 'answer' || !item.streaming || item.text !== '' || item.reasoning !== '' || isLast(items, item))
}

function isLast(items: readonly TranscriptItem[], item: TranscriptItem): boolean {
  return items.at(-1) === item
}
