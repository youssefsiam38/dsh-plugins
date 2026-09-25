/**
 * The review of one turn: a header with totals and Keep all / Revert all /
 * Re-diff, then every changed file with its hunks. Each hunk shows its lines,
 * its status, and Keep / Revert; a hunk in conflict shows how the file
 * differs now. Keyboard: j / k move between hunks, y keeps, n reverts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewFile, ReviewHunk, ReviewTarget, TurnReview } from '../types.ts'
import type { HunkReviewKey } from './locales.ts'
import type { ActionNotice, ReviewState } from './store.ts'

/** Class names; the stylesheet lives in `./styles.ts`. */
export const CLASS = {
  root: 'dsh-hunk-review',
  header: 'dsh-hunk-review-header',
  title: 'dsh-hunk-review-title',
  counts: 'dsh-hunk-review-counts',
  actions: 'dsh-hunk-review-actions',
  notice: 'dsh-hunk-review-notice',
  state: 'dsh-hunk-review-state',
  file: 'dsh-hunk-review-file',
  fileHeader: 'dsh-hunk-review-file-header',
  path: 'dsh-hunk-review-path',
  added: 'dsh-hunk-review-added',
  deleted: 'dsh-hunk-review-deleted',
  tag: 'dsh-hunk-review-tag',
  note: 'dsh-hunk-review-note',
  hunk: 'dsh-hunk-review-hunk',
  hunkHeader: 'dsh-hunk-review-hunk-header',
  status: 'dsh-hunk-review-status',
  lines: 'dsh-hunk-review-lines',
  line: 'dsh-hunk-review-line',
  number: 'dsh-hunk-review-number',
  sign: 'dsh-hunk-review-sign',
  text: 'dsh-hunk-review-text',
  conflict: 'dsh-hunk-review-conflict',
  hint: 'dsh-hunk-review-hint',
  chip: 'dsh-hunk-review-chip',
} as const

/** Props of {@link ReviewPanel}. */
export interface ReviewPanelProps {
  readonly state: ReviewState | undefined
  readonly notice: ActionNotice | undefined
  readonly busy: boolean
  /** File index to scroll to when the review first shows. */
  readonly initialIndex?: number | undefined
  readonly onKeep: (target: ReviewTarget) => void
  readonly onRevert: (target: ReviewTarget) => void
  readonly onRefresh: () => void
  readonly t: Translate<HunkReviewKey>
}

interface Focusable {
  readonly index: number
  readonly hunk: number
}

function numbered(hunk: Pick<ReviewHunk, 'oldStart' | 'newStart' | 'lines'>): { sign: string; text: string; old?: number; next?: number }[] {
  let old = hunk.oldStart
  let next = hunk.newStart
  return hunk.lines.map((line) => {
    const sign = line.slice(0, 1)
    const text = line.slice(1)
    if (sign === '-') return { sign, text, old: old++ }
    if (sign === '+') return { sign, text, next: next++ }
    return { sign: ' ', text, old: old++, next: next++ }
  })
}

function Lines({ hunk, numbers = true }: { hunk: Pick<ReviewHunk, 'oldStart' | 'newStart' | 'lines'>; numbers?: boolean }) {
  return (
    <div className={CLASS.lines} role="presentation">
      {numbered(hunk).map((line, at) => (
        <div key={at} className={CLASS.line} data-sign={line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'context'}>
          <span className={CLASS.number}>{numbers ? line.old ?? '' : ''}</span>
          <span className={CLASS.number}>{numbers ? line.next ?? '' : ''}</span>
          <span className={CLASS.sign}>{line.sign}</span>
          <span className={CLASS.text}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

function statusLabel(status: ReviewHunk['status'], t: Translate<HunkReviewKey>): string {
  switch (status) {
    case 'pending': return t('status.pending')
    case 'kept': return t('status.kept')
    case 'reverted': return t('status.reverted')
    case 'conflict': return t('status.conflict')
  }
}

function HunkView({ file, hunk, focused, busy, onFocus, onKeep, onRevert, onRefresh, t }: {
  file: ReviewFile
  hunk: ReviewHunk
  focused: boolean
  busy: boolean
  onFocus: () => void
  onKeep: () => void
  onRevert: () => void
  onRefresh: () => void
  t: Translate<HunkReviewKey>
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focused])
  return (
    <div ref={ref} className={CLASS.hunk} data-hunk-review-hunk={`${file.index}:${hunk.hunk}`} data-status={hunk.status}
      data-focused={focused || undefined} onMouseDown={onFocus}>
      <div className={CLASS.hunkHeader}>
        <span className={CLASS.status}>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</span>
        <span className={CLASS.tag} data-status={hunk.status}>{statusLabel(hunk.status, t)}</span>
        <span className={CLASS.actions}>
          {(hunk.status === 'pending') && (
            <Button size="sm" variant="ghost" disabled={busy} aria-label={t('action.keepAria')} data-hunk-review-action="keep" onClick={onKeep}>{t('action.keep')}</Button>
          )}
          {(hunk.status === 'pending' || hunk.status === 'kept') && (
            <Button size="sm" variant="outline" disabled={busy} aria-label={t('action.revertAria')} data-hunk-review-action="revert" onClick={onRevert}>{t('action.revert')}</Button>
          )}
          {hunk.status === 'conflict' && (
            <Button size="sm" variant="ghost" disabled={busy} aria-label={t('action.refreshAria')} data-hunk-review-action="refresh" onClick={onRefresh}>{t('action.refresh')}</Button>
          )}
        </span>
      </div>
      {hunk.status !== 'reverted' && <Lines hunk={hunk} />}
      {hunk.status === 'conflict' && hunk.drift !== undefined && (
        <div className={CLASS.conflict} data-hunk-review-conflict>
          <p className={CLASS.note}>{t('conflict.explain')}</p>
          <Lines hunk={{ oldStart: 0, newStart: 0, lines: hunk.drift }} numbers={false} />
        </div>
      )}
    </div>
  )
}

function fileNote(file: ReviewFile, t: Translate<HunkReviewKey>): string | undefined {
  switch (file.unreviewable) {
    case 'binary': return t('file.binary')
    case 'oversized': return t('file.oversized')
    case 'unavailable': return t('file.unavailable')
    case 'unreadable': return t('file.unreadable', { message: file.message ?? '' })
    case undefined: break
  }
  if (file.coarse) return t('file.coarse')
  if (!file.before) return t('file.createdNote')
  return undefined
}

function noticeText(notice: ActionNotice, t: Translate<HunkReviewKey>): string {
  if (notice.kind === 'failed') return t('result.failed', { message: notice.message })
  const reverted = notice.results.filter(result => result.outcome === 'reverted').length
  const conflicts = notice.results.filter(result => result.outcome === 'conflict').length
  const failed = notice.results.find(result => result.outcome === 'failed')
  const parts: string[] = []
  if (reverted === 1) parts.push(t('result.revertedOne'))
  else if (reverted > 1) parts.push(t('result.reverted', { count: reverted }))
  if (conflicts > 0) parts.push(t('result.conflicts', { count: conflicts }))
  if (failed !== undefined) parts.push(t('result.failed', { message: failed.reason ?? '' }))
  return parts.length === 0 ? t('result.nothing') : parts.join(' ')
}

function Header({ review, busy, onKeep, onRevert, onRefresh, t }: {
  review: TurnReview
  busy: boolean
  onKeep: (target: ReviewTarget) => void
  onRevert: (target: ReviewTarget) => void
  onRefresh: () => void
  t: Translate<HunkReviewKey>
}) {
  const pending = review.files.reduce((sum, file) => sum + file.hunks.filter(hunk => hunk.status === 'pending').length, 0)
  return (
    <div className={CLASS.header}>
      <span className={CLASS.title}>{t('header.title', { turn: review.turn })}</span>
      <span className={CLASS.counts} data-hunk-review-pending={pending}>{review.files.length === 1 ? t('header.countsOne', { pending }) : t('header.counts', { files: review.files.length, pending })}</span>
      <span className={CLASS.actions}>
        <Button size="sm" variant="ghost" disabled={busy} aria-label={t('action.refreshAria')} data-hunk-review-action="refresh-all" onClick={onRefresh}>{t('action.refresh')}</Button>
        <Button size="sm" variant="ghost" disabled={busy || pending === 0} data-hunk-review-action="keep-all" onClick={() => { onKeep({ scope: 'all' }) }}>{t('action.keepAll')}</Button>
        <Button size="sm" variant="outline" disabled={busy || pending === 0} data-hunk-review-action="revert-all" onClick={() => { onRevert({ scope: 'all' }) }}>{t('action.revertAll')}</Button>
      </span>
    </div>
  )
}

/**
 * Render the review of one turn.
 * @param props - see {@link ReviewPanelProps}.
 * @returns the review.
 */
export function ReviewPanel({ state, notice, busy, initialIndex, onKeep, onRevert, onRefresh, t }: ReviewPanelProps): ReactNode {
  const review = typeof state === 'object' && !('error' in state) ? state : undefined
  const order = useMemo<Focusable[]>(() => review === undefined
    ? []
    : review.files.flatMap(file => file.hunks.filter(hunk => hunk.status !== 'reverted').map(hunk => ({ index: file.index, hunk: hunk.hunk }))), [review])
  const [focus, setFocus] = useState<Focusable | undefined>(undefined)
  const scrolled = useRef(false)
  const fileRefs = useRef(new Map<number, HTMLElement>())
  useEffect(() => {
    if (scrolled.current || review === undefined || initialIndex === undefined) return
    scrolled.current = true
    fileRefs.current.get(initialIndex)?.scrollIntoView?.({ block: 'start' })
  }, [review, initialIndex])
  const position = focus === undefined ? -1 : order.findIndex(entry => entry.index === focus.index && entry.hunk === focus.hunk)
  const hunkOf = useCallback((entry: Focusable | undefined): ReviewHunk | undefined => (
    entry === undefined ? undefined : review?.files.find(file => file.index === entry.index)?.hunks[entry.hunk]
  ), [review])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]') !== null) return
    const move = (step: number): void => {
      if (order.length === 0) return
      const next = position < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(Math.max(position + step, 0), order.length - 1)
      setFocus(order[next])
    }
    const current = position < 0 ? undefined : order[position]
    const hunk = hunkOf(current)
    switch (event.key) {
      case 'j': move(1); break
      case 'k': move(-1); break
      case 'y':
        if (current === undefined || hunk?.status !== 'pending' || busy) return
        onKeep({ scope: 'hunk', index: current.index, hunk: current.hunk })
        move(1)
        break
      case 'n':
        if (current === undefined || (hunk?.status !== 'pending' && hunk?.status !== 'kept') || busy) return
        onRevert({ scope: 'hunk', index: current.index, hunk: current.hunk })
        // The reverted hunk leaves the order; the next one takes its place.
        setFocus(order[position + 1] ?? order[position - 1])
        break
      default: return
    }
    event.preventDefault()
  }

  let body: ReactNode
  if (state === undefined || state === 'loading') body = <p className={CLASS.state} role="status">{t('state.loading')}</p>
  else if (state === 'missing') body = <p className={CLASS.state}>{t('state.missing')}</p>
  else if ('error' in state) body = <p className={CLASS.state}>{t('state.error', { message: state.error })}</p>
  else if (state.files.length === 0) body = <p className={CLASS.state}>{t('state.empty')}</p>
  else {
    body = state.files.map((file) => {
      const note = fileNote(file, t)
      const pending = file.hunks.some(hunk => hunk.status === 'pending')
      return (
        <section key={file.index} className={CLASS.file} data-hunk-review-file={file.path}
          ref={(element) => { if (element === null) fileRefs.current.delete(file.index); else fileRefs.current.set(file.index, element) }}>
          <div className={CLASS.fileHeader}>
            <span className={CLASS.path} title={file.display}>{file.display}</span>
            {!file.before && <span className={CLASS.tag}>{t('file.created')}</span>}
            {!file.after && <span className={CLASS.tag}>{t('file.deleted')}</span>}
            <span className={CLASS.added}>{`+${file.added}`}</span>
            <span className={CLASS.deleted}>{`−${file.deleted}`}</span>
            <span className={CLASS.actions}>
              <Button size="sm" variant="ghost" disabled={busy || !pending} data-hunk-review-action="keep-file" onClick={() => { onKeep({ scope: 'file', index: file.index }) }}>{t('action.keepFile')}</Button>
              <Button size="sm" variant="outline" disabled={busy || !pending} data-hunk-review-action="revert-file" onClick={() => { onRevert({ scope: 'file', index: file.index }) }}>{t('action.revertFile')}</Button>
            </span>
          </div>
          {note !== undefined && <p className={CLASS.note}>{note}</p>}
          {file.hunks.map(hunk => (
            <HunkView key={hunk.hunk} file={file} hunk={hunk} busy={busy} t={t}
              focused={focus?.index === file.index && focus.hunk === hunk.hunk}
              onFocus={() => { setFocus({ index: file.index, hunk: hunk.hunk }) }}
              onKeep={() => { onKeep({ scope: 'hunk', index: file.index, hunk: hunk.hunk }) }}
              onRevert={() => { onRevert({ scope: 'hunk', index: file.index, hunk: hunk.hunk }) }}
              onRefresh={onRefresh} />
          ))}
        </section>
      )
    })
  }
  return (
    <div className={CLASS.root} tabIndex={0} onKeyDown={onKeyDown} data-hunk-review data-busy={busy || undefined}>
      {review !== undefined && <Header review={review} busy={busy} onKeep={onKeep} onRevert={onRevert} onRefresh={onRefresh} t={t} />}
      {notice !== undefined && <p className={CLASS.notice} role="status" data-hunk-review-notice={notice.kind}>{noticeText(notice, t)}</p>}
      {review !== undefined && review.total > review.files.length && <p className={CLASS.note}>{t('header.more', { count: review.total - review.files.length })}</p>}
      {body}
      {review !== undefined && review.files.length > 0 && <p className={CLASS.hint}>{t('keys.hint')}</p>}
    </div>
  )
}
