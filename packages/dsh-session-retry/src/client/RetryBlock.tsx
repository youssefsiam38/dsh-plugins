/**
 * The retry block docked at the end of the transcript, above the composer:
 * "Retrying 13/25 · next in 2 h" with a dimmed, slowly pulsing dot, an
 * exact-time tooltip, and Retry now / Stop actions. Renders nothing while no
 * retry is pending.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { phaseAt } from '../decision.ts'
import type { SessionRetryView } from '../types.ts'
import { en } from './locales.ts'
import type { SessionRetryKey } from './locales.ts'

/** Class names of the block; the stylesheet lives in `./styles.ts`. */
export const CLASS = {
  block: 'dsh-session-retry-block',
  dot: 'dsh-session-retry-dot',
  dotStill: 'dsh-session-retry-dot-still',
  text: 'dsh-session-retry-text',
  error: 'dsh-session-retry-error',
  actions: 'dsh-session-retry-actions',
} as const

/** Outcome of a block action. */
export type RetryActionResult = { readonly ok: true } | { readonly ok: false }

/** Actions the block invokes. */
export interface RetryBlockActions {
  /** Run the pending attempt now. */
  onRetryNow: () => Promise<RetryActionResult>
  /** Stop retrying this failure. */
  onStop: () => Promise<RetryActionResult>
}

/** Props of {@link RetryBlock}. */
export interface RetryBlockProps extends RetryBlockActions {
  /** Projection value; `undefined` while loading, `null` when nothing is pending. */
  view: SessionRetryView | null | undefined
  /** Current time in epoch milliseconds. */
  now: number
  /** Namespace translate function. */
  t: Translate<SessionRetryKey>
  /** Formats an epoch-millisecond instant as a local date and time. */
  formatDate?: (at: number) => string
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Short relative duration: seconds under a minute, minutes under an hour,
 * hours under two days, then days.
 * @param ms - remaining milliseconds.
 * @param t - namespace translate function.
 * @returns localized duration text.
 */
export function formatRemaining(ms: number, t: Translate<SessionRetryKey>): string {
  const remaining = Math.max(0, ms)
  if (remaining < MINUTE) return t('time.seconds', { n: Math.max(1, Math.ceil(remaining / SECOND)) })
  if (remaining < HOUR) return t('time.minutes', { n: Math.round(remaining / MINUTE) })
  if (remaining < 2 * DAY) return t('time.hours', { n: Math.round(remaining / HOUR) })
  return t('time.days', { n: Math.round(remaining / DAY) })
}

/**
 * How often the relative time must refresh to stay accurate.
 * @param ms - remaining milliseconds.
 * @returns the tick interval in milliseconds.
 */
export function tickInterval(ms: number): number {
  if (ms < 2 * MINUTE) return SECOND
  if (ms < 2 * HOUR) return 15 * SECOND
  return MINUTE
}

function defaultFormatDate(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

function reasonText(view: SessionRetryView, t: Translate<SessionRetryKey>): string {
  const key = `reason.${view.conditionId}`
  // Built-in reasons are localized; a third-party condition's reason is shown as it wrote it.
  return Object.hasOwn(en, key) ? t(key as SessionRetryKey) : view.reason
}

/** Presentational block for one session's retry state. */
export function RetryBlock({ view, now, t, onRetryNow, onStop, formatDate = defaultFormatDate }: RetryBlockProps) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const pendingRef = useRef(false)

  const failedAt = view?.failedAt
  useEffect(() => { setFailed(false) }, [failedAt])

  const run = useCallback(async (action: () => Promise<RetryActionResult>) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setFailed(false)
    let result: RetryActionResult
    try {
      result = await action()
    } catch (error: unknown) {
      // A rejected transport call is reported the same way as a refused command.
      void error
      result = { ok: false }
    }
    pendingRef.current = false
    setPending(false)
    if (!result.ok) setFailed(true)
  }, [])

  if (view === undefined || view === null) return null
  const phase = phaseAt(view, now)
  if (phase.kind === 'idle') return null
  const reason = reasonText(view, t)
  const max = view.maxAttempts

  let status: string
  let tooltip: string
  let live = true
  let canStop = true
  if (phase.kind === 'running') {
    status = t('status.running', { attempt: phase.attempt, max })
    tooltip = t('tooltip.reason', { reason })
    canStop = false
  } else if (phase.kind === 'exhausted') {
    status = t('status.exhausted', { max })
    tooltip = t('tooltip.exhausted', { reason })
    live = false
    canStop = false
  } else {
    const upcoming = phase.next ?? phase.due
    const parts = [t('status.waiting', { attempt: upcoming?.attempt ?? max, max })]
    if (view.waitsForReadiness && phase.due !== undefined) parts.push(t('status.notReady', { reason }))
    parts.push(phase.next === undefined ? t('status.due') : t('status.next', { time: formatRemaining(phase.next.at - now, t) }))
    status = parts.join(' · ')
    tooltip = phase.next === undefined
      ? t('tooltip.reason', { reason })
      : `${t('tooltip.next', { date: formatDate(phase.next.at) })} · ${t('tooltip.reason', { reason })}`
  }

  return (
    <div className={CLASS.block} role="status" aria-label={t('block.aria')} data-retry-phase={phase.kind}>
      <span className={live ? CLASS.dot : `${CLASS.dot} ${CLASS.dotStill}`} aria-hidden="true" />
      <Tooltip portal label={tooltip} side="top" delayMs={300} maxWidth={360}>
        <span className={CLASS.text} tabIndex={0} data-retry-tooltip={tooltip}>{status}</span>
      </Tooltip>
      {failed && <span className={CLASS.error} role="alert">{t('action.failed')}</span>}
      <div className={CLASS.actions}>
        {phase.kind !== 'running' && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void run(onRetryNow) }}>
            {t('action.retryNow')}
          </Button>
        )}
        {canStop && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void run(onStop) }}>
            {t('action.stop')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Current time that refreshes as fast as the view's countdown needs.
 * @param view - projection value.
 * @returns epoch milliseconds, updated on a timer.
 */
export function useRetryClock(view: SessionRetryView | null | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (view === undefined || view === null) return undefined
    const phase = phaseAt(view, now)
    if (phase.kind !== 'waiting') return undefined
    const target = phase.next?.at ?? view.giveUpAt
    const delay = Math.max(250, Math.min(tickInterval(target - now), target - now + 50))
    const timer = setTimeout(() => { setNow(Date.now()) }, delay)
    return () => { clearTimeout(timer) }
  }, [view, now])
  return now
}
