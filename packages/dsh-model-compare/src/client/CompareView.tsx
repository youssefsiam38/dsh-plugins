/**
 * The Compare view of a session: the setup form while no comparison is open,
 * then one column per lane. Desktop shows the columns side by side with
 * optional synchronized scrolling; narrow screens show one column at a time
 * in a horizontal swipe strip with a tab per model.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CompareModel, CompareRecord, CompareStateResponse } from '../types.ts'
import type { CompareApi } from './api.ts'
import type { LaneOwnerProps } from './Lane.tsx'
import type { SwitcherPrefs } from './prefs.ts'
import { Setup } from './Setup.tsx'
import type { Translate } from './Setup.tsx'
import { CLASS } from './styles.ts'

/** A lane's scrollport. */
const LANE_SCROLLER = '[data-model-compare-scroll]'

/** Viewport width at and below which lanes become swipeable tabs. */
export const NARROW_MEDIA = '(max-width: 720px)'

/** Browser services the view uses. */
export interface CompareDeps {
  readonly api: CompareApi
  readonly prefs: () => SwitcherPrefs
  /** Retain a lane session for rendering; the caller releases it. */
  readonly retain: (sessionId: string) => SessionReference
  /** Open a session in the main view; false when the page has no navigation service. */
  readonly open: (sessionId: string) => boolean
}

/** Props of {@link CompareView}. */
export interface CompareViewProps {
  readonly sessionId: string
  readonly deps: CompareDeps
  /** Render one lane inside its session scope. */
  readonly renderLane: (reference: SessionReference, owner: LaneOwnerProps) => ReactNode
  readonly t: Translate
}

type Load = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly state: CompareStateResponse }

function useNarrow(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_MEDIA) : undefined
  return useSyncExternalStore(
    (listener) => {
      query?.addEventListener('change', listener)
      return () => { query?.removeEventListener('change', listener) }
    },
    () => query?.matches ?? false,
  )
}

/**
 * Keep lane scrollports at the same relative position while enabled.
 * @param root - the lanes strip.
 * @param enabled - whether to synchronize.
 */
function useSyncedScroll(root: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (root === null || !enabled) return undefined
    let leader: Element | null = null
    let frame = 0
    const onScroll = (event: Event) => {
      const source = event.target
      if (!(source instanceof HTMLElement) || !source.matches(LANE_SCROLLER)) return
      if (leader !== null && leader !== source) return
      leader = source
      const range = source.scrollHeight - source.clientHeight
      const ratio = range <= 0 ? 0 : source.scrollTop / range
      for (const other of root.querySelectorAll<HTMLElement>(LANE_SCROLLER)) {
        if (other === source) continue
        other.scrollTop = ratio * Math.max(0, other.scrollHeight - other.clientHeight)
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { leader = null })
    }
    root.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [root, enabled])
}

function useLaneReferences(record: CompareRecord | null, retain: CompareDeps['retain']): ReadonlyMap<string, SessionReference> {
  const [references, setReferences] = useState<ReadonlyMap<string, SessionReference>>(new Map())
  const laneKey = record?.lanes.map(lane => lane.sessionId).join(',') ?? ''
  useEffect(() => {
    if (record === null) {
      setReferences(new Map())
      return undefined
    }
    const retained = new Map(record.lanes.map(lane => [lane.sessionId, retain(lane.sessionId)] as const))
    setReferences(retained)
    return () => {
      for (const reference of retained.values()) reference.release()
    }
    // Retain once per lane set; the record object changes on every refresh.
  }, [laneKey, retain])
  return references
}

/**
 * The Compare view.
 * @param props - source session, services, lane renderer, and translator.
 * @returns the setup form or the comparison columns.
 */
export function CompareView({ sessionId, deps, renderLane, t }: CompareViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [adopting, setAdopting] = useState<string | undefined>()
  const [sync, setSync] = useState(true)
  const [activeTab, setActiveTab] = useState(0)
  const [strip, setStrip] = useState<HTMLDivElement | null>(null)
  const narrow = useNarrow()
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const result = await deps.api.state(sessionId)
    if (!alive.current) return
    setLoad(result.ok ? { kind: 'ready', state: result.value } : { kind: 'error', message: result.error })
  }, [deps.api, sessionId])

  useEffect(() => {
    alive.current = true
    setLoad({ kind: 'loading' })
    setError(undefined)
    setNotice(undefined)
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const record = load.kind === 'ready' ? load.state.compare : null
  const references = useLaneReferences(record, deps.retain)
  useSyncedScroll(strip, sync && !narrow)

  const start = useCallback((prompt: string, models: CompareModel[]) => {
    setBusy(true)
    setError(undefined)
    void deps.api.start(sessionId, prompt, models).then(async (result) => {
      if (!alive.current) return
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setActiveTab(0)
      await refresh()
    })
  }, [deps.api, sessionId, refresh])

  const act = useCallback(async (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(undefined)
    const result = await action()
    if (!alive.current) return
    if (!result.ok) setError(result.error)
    await refresh()
  }, [refresh])

  if (load.kind === 'loading') return <div className={CLASS.root} data-model-compare=""><p className={CLASS.muted}>{t('lane.loading')}</p></div>
  if (load.kind === 'error') {
    return (
      <div className={CLASS.root} data-model-compare="">
        <p className={CLASS.error} role="alert">{t('error.load', { message: load.message })}</p>
        <button type="button" className={CLASS.secondary} onClick={() => { void refresh() }}>{t('error.retry')}</button>
      </div>
    )
  }
  if (record === null) {
    return (
      <div className={CLASS.root} data-model-compare="">
        {notice !== undefined && <p className={CLASS.notice}>{notice}</p>}
        <Setup key={sessionId} state={load.state} prefs={deps.prefs()} busy={busy} error={error} onStart={start} t={t} />
      </div>
    )
  }

  const adopt = (laneSessionId: string) => {
    setAdopting(laneSessionId)
    void act(async () => {
      const result = await deps.api.adopt(record.compareId, laneSessionId)
      if (alive.current) setAdopting(undefined)
      if (!result.ok) return result
      if (!deps.open(result.value) && alive.current) setNotice(t('error.navigate'))
      return { ok: true }
    })
  }
  const showTab = (index: number) => {
    setActiveTab(index)
    // Each lane is exactly one strip width wide on narrow screens.
    strip?.scrollTo({ left: index * strip.clientWidth, behavior: 'smooth' })
  }

  return (
    <div className={CLASS.root} data-model-compare="" data-narrow={narrow ? '' : undefined}>
      <div className={CLASS.bar}>
        <div className={CLASS.promptBox} title={record.prompt}>
          <span className={CLASS.label}>{t('compare.prompt')}</span>
          <span className={CLASS.promptText} data-model-compare-shown-prompt="">{record.prompt}</span>
        </div>
        <div className={CLASS.barActions}>
          {!narrow && (
            <label className={CLASS.toggle}>
              <input type="checkbox" checked={sync} onChange={(event) => { setSync(event.target.checked) }} />
              {t('compare.sync')}
            </label>
          )}
          <button type="button" className={CLASS.secondary} disabled={adopting !== undefined} onClick={() => { void act(() => deps.api.stop(record.compareId)) }}>{t('compare.stopAll')}</button>
          <button
            type="button"
            className={CLASS.secondary}
            disabled={adopting !== undefined}
            data-model-compare-discard=""
            onClick={() => {
              if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('compare.discardConfirm'))) return
              void act(() => deps.api.discard(record.compareId))
            }}
          >{t('compare.discard')}</button>
        </div>
      </div>
      {error !== undefined && <p className={CLASS.error} role="alert">{error}</p>}
      {narrow && (
        <div className={CLASS.tabs} role="tablist">
          {record.lanes.map((lane, index) => (
            <button
              key={lane.sessionId}
              type="button"
              role="tab"
              aria-selected={index === activeTab}
              className={CLASS.tab}
              onClick={() => { showTab(index) }}
            >{lane.label}</button>
          ))}
        </div>
      )}
      <div
        className={CLASS.lanes}
        ref={setStrip}
        style={{ ['--dmc-count' as string]: String(record.lanes.length) }}
        onScroll={narrow
          ? (event) => {
              const element = event.currentTarget
              const index = Math.round(element.scrollLeft / Math.max(1, element.clientWidth))
              if (index !== activeTab) setActiveTab(index)
            }
          : undefined}
      >
        {record.lanes.map((lane, index) => {
          const reference = references.get(lane.sessionId)
          return (
            <div key={lane.sessionId} className={CLASS.laneSlot}>
              {reference === undefined
                ? null
                : renderLane(reference, {
                    lane,
                    index,
                    locked: adopting !== undefined,
                    adopting: adopting === lane.sessionId,
                    onAdopt: () => { adopt(lane.sessionId) },
                    onStop: () => { void act(() => deps.api.stop(record.compareId, lane.sessionId)) },
                  })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
