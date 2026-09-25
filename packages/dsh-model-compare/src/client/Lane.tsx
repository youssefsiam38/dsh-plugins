/**
 * One comparison column: the lane's model, status, and statistics, its
 * compact transcript in its own scrollport, and the lane actions.
 */

import { useEffect, useRef } from 'react'
import type { CompareLane, LaneStatsView } from '../types.ts'
import { seconds, tokens, usd } from './format.ts'
import type { Translate } from './Setup.tsx'
import { CLASS } from './styles.ts'
import { Transcript } from './Transcript.tsx'
import type { TranscriptItem } from './transcript.ts'

/** What the comparison view passes to each lane. */
export interface LaneOwnerProps {
  readonly lane: CompareLane
  readonly index: number
  /** Whether another lane is being adopted (all lane actions pause). */
  readonly locked: boolean
  /** Whether this lane is being adopted. */
  readonly adopting: boolean
  readonly onAdopt: () => void
  readonly onStop: () => void
}

/** Status key of a lane from its statistics and live state. */
export function laneStatus(stats: LaneStatsView | undefined, running: boolean): 'waiting' | 'running' | NonNullable<LaneStatsView['outcome']> {
  if (stats === undefined || stats.phase === 'waiting') return running ? 'running' : 'waiting'
  if (stats.phase === 'running') return 'running'
  return stats.outcome ?? 'other'
}

/**
 * The statistics line.
 * @param props - statistics and translator.
 * @param props.stats - the lane's statistics, when known.
 * @param props.t - translator.
 * @returns the line, or nothing before the lane starts.
 */
export function LaneStats({ stats, t }: { stats: LaneStatsView | undefined; t: Translate }) {
  if (stats === undefined || stats.phase === 'waiting') return null
  const parts: string[] = []
  if (stats.ttftMs !== undefined) parts.push(t('stats.ttft', { value: t('stats.seconds', { value: seconds(stats.ttftMs) }) }))
  if (stats.latencyMs !== undefined) parts.push(t('stats.latency', { value: t('stats.seconds', { value: seconds(stats.latencyMs) }) }))
  if (stats.inputTokens > 0 || stats.outputTokens > 0) parts.push(t('stats.tokens', { input: tokens(stats.inputTokens), output: tokens(stats.outputTokens) }))
  if (stats.reasoningTokens > 0) parts.push(t('stats.reasoning', { value: tokens(stats.reasoningTokens) }))
  if (stats.tokensPerSecond !== undefined) parts.push(t('stats.speed', { value: stats.tokensPerSecond.toFixed(stats.tokensPerSecond < 10 ? 1 : 0) }))
  if (stats.costUsd !== undefined) parts.push(t('stats.cost', { value: usd(stats.costUsd) }))
  else if (stats.requests > 0 && stats.phase === 'ended') parts.push(t('stats.costUnknown'))
  if (parts.length === 0) return null
  return (
    <div className={CLASS.stats} data-model-compare-stats="">
      {parts.map(part => <span key={part}>{part}</span>)}
    </div>
  )
}

/** Props of {@link LaneView}. */
export interface LaneViewProps extends LaneOwnerProps {
  readonly stats: LaneStatsView | undefined
  readonly running: boolean
  readonly loading: boolean
  readonly items: readonly TranscriptItem[]
  readonly t: Translate
}

/**
 * One lane column.
 * @param props - lane facts, statistics, the rendered chat, and actions.
 * @returns the column.
 */
export function LaneView({ lane, index, stats, running, loading, items, locked, adopting, onAdopt, onStop, t }: LaneViewProps) {
  const status = laneStatus(stats, running)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Follow the streaming answer while the reader stays at the bottom.
  useEffect(() => {
    const element = scroller.current
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight
  }, [items])
  const active = status === 'running' || status === 'waiting'
  return (
    <section className={CLASS.lane} data-model-compare-lane={lane.sessionId} data-status={status} aria-label={lane.label}>
      <header className={CLASS.laneHeader}>
        <div className={CLASS.laneTitle}>
          <span className={CLASS.laneIndex} aria-hidden="true">{index + 1}</span>
          <span className={CLASS.laneName} title={`${lane.provider} · ${lane.model}`}>{lane.label}</span>
          <span className={CLASS.status} data-status={status} role="status">{t(`lane.${status}`)}</span>
        </div>
        <LaneStats stats={stats} t={t} />
        {stats?.errorMessage !== undefined && <div className={CLASS.error}>{stats.errorMessage}</div>}
        <div className={CLASS.laneActions}>
          {active
            ? <button type="button" className={CLASS.secondary} onClick={onStop} disabled={locked}>{t('lane.stop')}</button>
            : (
              <button type="button" className={CLASS.primary} onClick={onAdopt} disabled={locked} data-model-compare-adopt="">
                {adopting ? t('lane.adopting') : t('lane.adopt')}
              </button>
            )}
        </div>
      </header>
      <div
        ref={scroller}
        className={CLASS.laneScroll}
        data-model-compare-scroll=""
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
      >
        {loading && items.length === 0 ? <div className={CLASS.muted}>{t('lane.loading')}</div> : <Transcript items={items} t={t} />}
      </div>
    </section>
  )
}
