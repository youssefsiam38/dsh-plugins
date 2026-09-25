/**
 * Fork boundary of a comparison: the lanes inherit the source session's
 * history up to its latest completed turn, so a turn still running in the
 * source never leaks a half-written step into them.
 * @module dsh-model-compare/fork
 */

/** The event fields the boundary reads. */
export interface BoundaryEvent {
  readonly type: string
  readonly seq: number
}

/** Event types that begin new work after a completed turn. */
const WORK_START: ReadonlySet<string> = new Set(['turn/start', 'user/message', 'agent/inbox/spliced'])

/**
 * Pick the inclusive fork boundary: the last `turn/end`, extended over the
 * standalone events that follow it (titles, model selections, command
 * records) up to the next event that begins new work.
 * @param events - the source session's events in seq order.
 * @returns the boundary seq, or undefined when no turn completed (lanes then start without history).
 */
export function forkBoundary(events: readonly BoundaryEvent[]): number | undefined {
  let lastEnd = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === 'turn/end') {
      lastEnd = index
      break
    }
  }
  if (lastEnd < 0) return undefined
  let boundary = lastEnd
  for (let index = lastEnd + 1; index < events.length; index += 1) {
    if (WORK_START.has(events[index]!.type)) break
    boundary = index
  }
  return events[boundary]!.seq
}
