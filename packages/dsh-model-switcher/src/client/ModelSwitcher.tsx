/**
 * The composer model picker (`conversation.input.model`, shadowing the stock
 * control). The trigger opens a popover (a bottom sheet on narrow screens)
 * with two searches:
 * 1. a provider combobox (default "All providers") listing each provider with
 *    its logo, model count, and key status; picking one moves focus to
 * 2. a model combobox over a listbox grouped by provider, with Favorites and
 *    Recent on top while the search is blank.
 * Both searches keep DOM focus in their input and point `aria-activedescendant`
 * at the active option (WAI-ARIA APG combobox). Tab and Shift+Tab cycle the
 * focus stops (sheet close button, provider search, model search, effort
 * buttons) inside the surface. A footer sets the reasoning effort of the
 * current model. Reads and writes go through the stock plugin's per-session
 * model directory, so the `/model` popup and this picker always agree.
 * @module dsh-model-switcher/client/ModelSwitcher
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type MutableRefObject, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular,
  IconWarningOutlineRegular, Toast, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SwitcherSettings } from '../settings.ts'
import { CLASS } from './classes.ts'
import { AllProvidersGlyph, ProviderLogo } from './icons.tsx'
import type { ProviderInsights } from './insights.ts'
import type { ModelSwitcherKey } from './locales.ts'
import type { PrefsStore } from './prefs.ts'
import {
  buildSections, filterProviders, formatTokens, modelEntries, modelKey, providerEntries,
} from './search.ts'
import type { ModelEntry, ProviderEntry, ProviderStatus, Section } from './search.ts'

/** Translator for this plugin's namespace. */
export type Translate = (key: ModelSwitcherKey, params?: Record<string, string | number>) => string

/** Outcome of a selection, as the stock directory returns it. */
export type SelectOutcome = { ok: true } | { ok: false; error: { code: string; message: string } } | undefined

/** The directory snapshot fields the picker reads (the stock `ModelDirectoryState`). */
export interface DirectoryView {
  readonly current: ModelSelection | null
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly error: string | null
}

/** Observable directory store. */
export interface DirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): DirectoryView
}

/** Everything the picker needs for one session. */
export interface SwitcherFace {
  /** Whether this session supports model selection (false for addressed subagent sessions). */
  readonly available: boolean
  readonly directory: DirectoryStore
  /** Ensure the shared catalog is loaded; failures land on the store. */
  readonly load: () => void
  /** Submit a complete selection. */
  readonly select: (selection: ModelSelection) => Promise<SelectOutcome>
  readonly prefs: PrefsStore
  readonly insights: ProviderInsights
  readonly settings: SwitcherSettings
}

/** Props of {@link ModelSwitcher}. */
export type ModelSwitcherProps = SwitcherFace & { readonly locked: boolean; readonly t: Translate }

/** Viewport width at and below which the picker opens as a bottom sheet. */
export const SHEET_MEDIA = '(max-width: 640px)'

/** Rows moved by PageUp / PageDown. */
const PAGE = 8

function useNarrow(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(SHEET_MEDIA) : undefined
  return useSyncExternalStore(
    (listener) => {
      query?.addEventListener('change', listener)
      return () => { query?.removeEventListener('change', listener) }
    },
    () => query?.matches ?? false,
  )
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One focusable row of the flattened list. */
interface FlatOption {
  readonly id: string
  readonly entry: ModelEntry
}

/**
 * Render the trigger and, while open, the picker surface.
 * @param props - the session face, the owner's `locked` flag, and the translator.
 * @returns the picker, or nothing for a session without model selection.
 */
export function ModelSwitcher(props: ModelSwitcherProps) {
  const { available, directory, load, select, prefs, insights, settings, locked, t } = props
  const state = useSyncExternalStore(directory.subscribe.bind(directory), directory.getSnapshot.bind(directory))
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const id = useId()

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const current = state.current
  const currentEntry = useMemo(() => {
    if (current === null) return undefined
    for (const group of state.groups) {
      if (group.id !== current.provider) continue
      const model = group.models.find(candidate => candidate.id === current.model)
      if (model !== undefined) return { group, model }
    }
    return undefined
  }, [current, state.groups])
  const reasoning = currentEntry?.model.reasoning
  const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }, [])

  const settle = useCallback((outcome: SelectOutcome, onOk: () => void): void => {
    if (outcome === undefined) return
    if (outcome.ok) {
      onOk()
      return
    }
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: outcome.error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${outcome.error.code}: ${outcome.error.message}` }),
    })
  }, [t])

  if (!available) return null

  const waiting = current === null && (state.status === 'loading' || state.status === 'idle')
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentEntry?.model.name ?? (current === null ? t('trigger.fallback') : `${current.provider}/${current.model}`)
  const triggerAria = waiting
    ? t('trigger.loading')
    : current === null
      ? t('trigger.ariaEmpty')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  return (
    <div ref={rootRef} className={CLASS.root} data-model-switcher="">
      <button
        ref={triggerRef}
        type="button"
        className={CLASS.trigger}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        title={effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`}
        disabled={locked}
        data-model-switcher-trigger=""
        onClick={() => {
          if (open) {
            close(true)
            return
          }
          setOpen(true)
          load()
        }}
      >
        <span className={CLASS.triggerLogo}>
          {current === null
            ? <AllProvidersGlyph size={14} />
            : <ProviderLogo id={current.provider} name={currentEntry?.group.name ?? current.provider} url={settings.providerIcons[current.provider]} size={14} />}
        </span>
        <span className={CLASS.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={CLASS.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutlineRegular className={CLASS.chevron} data-open={open ? '' : undefined} />
      </button>
      {open && (
        <SwitcherPanel
          id={`${id}-panel`}
          panelRef={panelRef}
          anchorRef={triggerRef}
          placement={COMPOSER_PLACEMENT}
          state={state}
          selectedKeys={current === null ? NO_KEYS : new Set([modelKey(current.provider, current.model)])}
          load={load}
          prefs={prefs}
          insights={insights}
          settings={settings}
          effortLabel={effortLabel}
          effectiveEffort={effectiveEffort}
          t={t}
          onClose={close}
          onChoose={(entry) => {
            if (current?.provider === entry.provider && current.model === entry.id) {
              close(true)
              return
            }
            void select({ provider: entry.provider, model: entry.id }).then(outcome => settle(outcome, () => {
              prefs.pushRecent(entry.key)
              if (rootRef.current !== null) close(true)
            }))
          }}
          onEffort={(effort) => {
            if (current === null) return
            if (effectiveEffort === effort) {
              close(true)
              return
            }
            void select({
              provider: current.provider,
              model: current.model,
              ...effort === undefined ? {} : { reasoningEffort: effort },
            }).then(outcome => settle(outcome, () => {
              if (rootRef.current !== null) close(true)
            }))
          }}
        />
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}

/** Where an anchored surface hangs from its anchor. */
export interface PanelPlacement {
  readonly side: 'top' | 'bottom'
  readonly align: 'start' | 'end'
}

/** The composer popover opens above the trigger, right-aligned. */
const COMPOSER_PLACEMENT: PanelPlacement = { side: 'top', align: 'end' }

const NO_KEYS: ReadonlySet<string> = new Set()

/** Picker-mode state of the surface (the `modelSwitcher.pick` service). */
export interface PanelPick {
  /** Whether rows toggle a check and Done confirms. */
  readonly multiple: boolean
  /** Checked models. */
  readonly count: number
  /** Most checked models, if limited. */
  readonly max: number | undefined
  /** Confirm a multiple pick. */
  readonly onDone: () => void
}

/** Props of the open surface. */
export interface PanelProps {
  readonly id: string
  readonly panelRef: MutableRefObject<HTMLDivElement | null>
  /** Element the surface is placed from; an empty ref centers it (phones use the sheet either way). */
  readonly anchorRef: MutableRefObject<HTMLElement | null>
  readonly placement: PanelPlacement
  readonly state: DirectoryView
  /** Rows shown checked: the session's model in the composer, the checked models in picker mode. */
  readonly selectedKeys: ReadonlySet<string>
  /** Dialog label and sheet title; defaults to the composer's. */
  readonly title?: string
  /** Picker mode; absent for the composer control. */
  readonly pick?: PanelPick
  readonly load: () => void
  readonly prefs: PrefsStore
  readonly insights: ProviderInsights
  readonly settings: SwitcherSettings
  readonly effortLabel: string | undefined
  readonly effectiveEffort: string | undefined
  readonly t: Translate
  readonly onClose: (restoreFocus: boolean) => void
  readonly onChoose: (entry: ModelEntry) => void
  readonly onEffort: (effort: string | undefined) => void
}

/** Sentinel id of the "All providers" option. */
const ALL = '\u0000all'

/**
 * The open picker surface: provider select, model search, grouped list, and
 * (composer only) the effort row or (picker mode, multiple) the Done bar.
 * @param props - data, placement, mode, and callbacks.
 * @returns the surface, portaled to `document.body`.
 */
export function SwitcherPanel(props: PanelProps) {
  const { id, panelRef, anchorRef, placement, state, load, prefs: prefsStore, insights: insightStore, settings, t, pick } = props
  const prefs = useSyncExternalStore(prefsStore.subscribe, prefsStore.getSnapshot)
  const insight = useSyncExternalStore(insightStore.subscribe, insightStore.getSnapshot)
  const narrow = useNarrow()
  const centered = !narrow && anchorRef.current === null
  const position = useAnchoredPosition({
    open: !narrow && !centered, anchorRef, panelRef, side: placement.side, align: placement.align, gap: 8, margin: 12,
  })
  const title = props.title ?? t('dialog.label')
  const full = pick !== undefined && pick.multiple && pick.max !== undefined && pick.count >= pick.max

  const [provider, setProvider] = useState<string | undefined>(undefined)
  const [providerQuery, setProviderQuery] = useState('')
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerActive, setProviderActive] = useState(0)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const lastLoad = useRef(true)

  const providerInputRef = useRef<HTMLInputElement | null>(null)
  const modelInputRef = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const effortRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)

  const busy = state.status === 'selecting'
  const current = state.current
  const currentKey = current === null ? undefined : modelKey(current.provider, current.model)
  const doneRef = useRef<HTMLButtonElement | null>(null)

  // Enrichment follows the providers the directory lists.
  const providerIds = useMemo(() => state.groups.map(group => group.id), [state.groups])
  useEffect(() => { void insightStore.ensure(providerIds) }, [insightStore, providerIds])

  const entries = useMemo(() => modelEntries(state.groups, insight.meta), [state.groups, insight.meta])
  const providers = useMemo(() => providerEntries(state.groups, state.failures, insight.status), [state.groups, state.failures, insight.status])
  const providerById = useMemo(() => new Map(providers.map(entry => [entry.id, entry])), [providers])
  const selectedProvider = provider === undefined ? undefined : providerById.get(provider)
  const allLabel = t('provider.all')
  const providerOptions = useMemo<readonly (ProviderEntry | typeof ALL)[]>(() => {
    const matches = filterProviders(providers, providerQuery)
    const showAll = providerQuery.trim() === '' || filterProviders([{ id: 'all', name: allLabel, count: 0, status: 'unknown' }], providerQuery).length > 0
    return showAll ? [ALL, ...matches] : matches
  }, [providers, providerQuery, allLabel])

  const favorites = useMemo(() => new Set(prefs.favorites), [prefs.favorites])
  const sections = useMemo(() => buildSections({
    entries, query, provider, favorites, recents: prefs.recents, recentLimit: settings.recentLimit,
  }), [entries, query, provider, favorites, prefs.recents, settings.recentLimit])
  const flat = useMemo<FlatOption[]>(() => sections.flatMap(section =>
    section.entries.map((entry, index) => ({ id: `${id}-${section.id}-${index}`, entry }))), [sections, id])

  // A new result set starts on the current model when it is listed, else on the first row.
  useEffect(() => {
    const at = query.trim() === '' ? flat.findIndex(option => option.entry.key === currentKey) : -1
    setActive(at >= 0 ? at : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-anchor only when the result set changes, not on selection updates.
  }, [query, provider, flat.length])

  const activeOption = flat[Math.min(active, flat.length - 1)]
  useEffect(() => {
    if (activeOption === undefined) return
    const element = document.getElementById(activeOption.id)
    if (element !== null && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
  }, [activeOption])

  // Initial focus: the configured search.
  useLayoutEffect(() => {
    const target = settings.initialFocus === 'providers' ? providerInputRef.current : modelInputRef.current
    target?.focus()
    if (settings.initialFocus === 'providers') setProviderOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per open.
  }, [])

  const effortChoices = useMemo(() => {
    const reasoning = current === null || pick !== undefined
      ? undefined
      : state.groups.find(group => group.id === current.provider)?.models.find(model => model.id === current.model)?.reasoning
    if (reasoning === undefined) return []
    return [
      ...reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined as string | undefined, label: t('effort.providerDefault') }] : [],
      ...reasoning.efforts.map(level => ({ key: `effort:${level.id}`, effort: level.id as string | undefined, label: level.name })),
    ]
  }, [current, pick, state.groups, t])

  const focusStops = (): HTMLElement[] => {
    const stops: (HTMLElement | null | undefined)[] = [
      narrow ? closeRef.current : null,
      providerInputRef.current,
      modelInputRef.current,
      effortRefs.current.find((button, index) => button !== null && effortChoices[index]?.effort === props.effectiveEffort)
        ?? effortRefs.current.find(button => button !== null),
      doneRef.current,
    ]
    return stops.filter((stop): stop is HTMLElement => stop !== null && stop !== undefined && !(stop instanceof HTMLButtonElement && stop.disabled))
  }

  const cycleFocus = (backward: boolean): void => {
    const stops = focusStops()
    if (stops.length === 0) return
    const focused = document.activeElement
    const inEffort = focused instanceof HTMLElement && focused.dataset['effort'] !== undefined
    const at = stops.findIndex(stop => stop === focused || (inEffort && stop.dataset['effort'] !== undefined))
    const next = stops[((at === -1 ? (backward ? 0 : -1) : at) + (backward ? -1 : 1) + stops.length) % stops.length]
    next?.focus()
  }

  const pickProvider = (option: ProviderEntry | typeof ALL): void => {
    setProvider(option === ALL ? undefined : option.id)
    setProviderQuery('')
    setProviderOpen(false)
    modelInputRef.current?.focus()
  }

  const reload = (): void => {
    lastLoad.current = true
    load()
  }

  const choose = (entry: ModelEntry): void => {
    if (busy || (full && !props.selectedKeys.has(entry.key))) return
    lastLoad.current = false
    props.onChoose(entry)
  }

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      cycleFocus(event.shiftKey)
      return
    }
    if (event.key === 'Escape' && event.target === event.currentTarget) {
      event.preventDefault()
      event.stopPropagation()
      props.onClose(true)
    }
  }

  const onProviderKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = providerOptions.length
    const move = (delta: number): void => {
      event.preventDefault()
      setProviderOpen(true)
      if (count > 0) setProviderActive(index => (index + delta + count) % count)
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) return move(1)
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) return move(-1)
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const option = providerOptions[providerActive]
      if (option !== undefined) pickProvider(option)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (providerQuery !== '') setProviderQuery('')
      else if (providerOpen) { setProviderOpen(false); modelInputRef.current?.focus() }
      else props.onClose(true)
    }
  }

  const onModelKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = flat.length
    const move = (delta: number, wrap: boolean): void => {
      event.preventDefault()
      if (count === 0) return
      setActive((index) => {
        const next = index + delta
        return wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next))
      })
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) return move(1, true)
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) return move(-1, true)
    if (event.key === 'PageDown') return move(PAGE, false)
    if (event.key === 'PageUp') return move(-PAGE, false)
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (pick?.multiple === true && (event.metaKey || event.ctrlKey)) pick.onDone()
      else if (activeOption !== undefined) choose(activeOption.entry)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (activeOption !== undefined) prefsStore.toggleFavorite(activeOption.entry.key)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (query !== '') setQuery('')
      else props.onClose(true)
    }
  }

  const onEffortKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = effortRefs.current.filter((button): button is HTMLButtonElement => button !== null)
    const at = buttons.findIndex(button => button === document.activeElement)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
      buttons[(at + delta + buttons.length) % buttons.length]?.focus()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onClose(true)
    }
  }

  const loadError = state.error !== null && lastLoad.current && state.status === 'error'
  const providerListId = `${id}-providers`
  const modelListId = `${id}-models`
  const activeProviderOption = providerOptions[providerActive]
  const statusText = state.status === 'loading'
    ? (state.groups.length === 0 ? t('status.loading') : t('status.refreshing'))
    : flat.length === 1 ? t('status.resultsOne') : t('status.results', { count: flat.length })
  const providerName = selectedProvider?.name ?? provider

  const surface = (
    <div
      ref={panelRef}
      id={id}
      className={CLASS.panel}
      role="dialog"
      aria-modal={narrow ? 'true' : undefined}
      aria-label={title}
      data-sheet={narrow ? '' : undefined}
      data-centered={centered ? '' : undefined}
      data-model-switcher-panel=""
      data-model-switcher-pick={pick === undefined ? undefined : pick.multiple ? 'multiple' : 'single'}
      style={narrow || centered ? undefined : position ?? { opacity: 0, pointerEvents: 'none', left: 0, top: 0 }}
      onKeyDown={onPanelKeyDown}
      onMouseDown={(event) => {
        // Keep focus in the active search while the pointer works the lists.
        if (event.target instanceof Element && event.target.closest('input, [data-effort]') === null) event.preventDefault()
      }}
    >
      {narrow && (
        <div className={CLASS.sheetHeader}>
          <span className={CLASS.sheetTitle}>{title}</span>
          <button ref={closeRef} type="button" className={CLASS.close} aria-label={t('dialog.close')} onClick={() => { props.onClose(true) }}>
            <IconCloseOutlineRegular />
          </button>
        </div>
      )}

      <div className={CLASS.providerBar}>
        <label className={CLASS.field} data-open={providerOpen ? '' : undefined}>
          <span className={CLASS.fieldIcon}>
            {provider === undefined || selectedProvider === undefined
              ? <AllProvidersGlyph />
              : <ProviderLogo id={selectedProvider.id} name={selectedProvider.name} url={settings.providerIcons[selectedProvider.id]} />}
          </span>
          <span className={CLASS.srOnly}>{t('provider.label')}</span>
          <input
            ref={providerInputRef}
            className={CLASS.input}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={providerOpen}
            aria-controls={providerListId}
            aria-activedescendant={providerOpen && activeProviderOption !== undefined ? `${providerListId}-${providerActive}` : undefined}
            placeholder={providerName ?? allLabel}
            value={providerQuery}
            spellCheck={false}
            autoComplete="off"
            data-model-switcher-provider-search=""
            onChange={(event) => {
              setProviderQuery(event.target.value)
              setProviderOpen(true)
              setProviderActive(0)
            }}
            onFocus={() => {
              setProviderOpen(true)
              const at = providerOptions.findIndex(option => (option === ALL ? undefined : option.id) === provider)
              setProviderActive(at >= 0 ? at : 0)
            }}
            onBlur={() => { setProviderOpen(false); setProviderQuery('') }}
            onKeyDown={onProviderKeyDown}
          />
          <IconChevronDownOutlineRegular className={CLASS.chevron} data-open={providerOpen ? '' : undefined} />
        </label>
        <div id={providerListId} role="listbox" aria-label={t('provider.label')} className={CLASS.providerList} hidden={!providerOpen}>
          {providerOptions.map((option, index) => {
            const selected = option === ALL ? provider === undefined : option.id === provider
            return (
              <div
                key={option === ALL ? ALL : option.id}
                id={`${providerListId}-${index}`}
                role="option"
                aria-selected={selected}
                className={CLASS.providerOption}
                data-active={index === providerActive ? '' : undefined}
                data-provider={option === ALL ? '' : option.id}
                onMouseMove={() => { if (index !== providerActive) setProviderActive(index) }}
                onClick={() => { pickProvider(option) }}
              >
                {option === ALL
                  ? <AllProvidersGlyph />
                  : <ProviderLogo id={option.id} name={option.name} url={settings.providerIcons[option.id]} />}
                <span className={CLASS.providerName}>{option === ALL ? allLabel : option.name}</span>
                <span className={CLASS.providerMeta}>
                  {option === ALL
                    ? countLabel(entries.length, t)
                    : <>{option.status !== 'error' && countLabel(option.count, t)}<StatusTag status={option.status} message={option.message} t={t} /></>}
                </span>
                <span className={CLASS.check}>{selected ? <IconCheckOutlineRegular /> : null}</span>
              </div>
            )
          })}
          {providerOptions.length === 0 && <div className={CLASS.empty}>{t('provider.none', { query: providerQuery })}</div>}
        </div>
      </div>

      <label className={`${CLASS.field} ${CLASS.modelField}`}>
        <span className={CLASS.fieldIcon}><IconSearchOutlineRegular /></span>
        <span className={CLASS.srOnly}>{t('model.label')}</span>
        <input
          ref={modelInputRef}
          className={CLASS.input}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={modelListId}
          aria-activedescendant={activeOption?.id}
          placeholder={providerName === undefined ? t('model.search') : t('model.searchIn', { provider: providerName })}
          value={query}
          spellCheck={false}
          autoComplete="off"
          data-model-switcher-search=""
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={onModelKeyDown}
        />
      </label>

      <div className={CLASS.srOnly} role="status" aria-live="polite">{statusText}</div>

      {loadError && (
        <div className={`${CLASS.notice} ${CLASS.noticeError}`}>
          <span>{t('error.load', { message: state.error ?? '' })}</span>
          <button type="button" className={CLASS.link} onClick={reload}>{t('action.retry')}</button>
        </div>
      )}
      {state.failures.filter(failure => provider === undefined || failure.id === provider).map(failure => (
        <div className={CLASS.notice} key={failure.id}>
          <span>{t('error.group', { name: failure.name, message: failure.message })}</span>
          <button type="button" className={CLASS.link} onClick={reload}>{t('action.retry')}</button>
        </div>
      ))}

      <div
        ref={listRef}
        id={modelListId}
        role="listbox"
        aria-label={t('model.label')}
        aria-multiselectable={pick?.multiple === true ? 'true' : undefined}
        aria-busy={state.status === 'loading' || busy}
        className={`${CLASS.list} scrollable`}
      >
        {sections.map((section) => {
          const headingId = `${id}-${section.id}-title`
          return (
            <div role="group" aria-labelledby={headingId} className={CLASS.group} key={section.id} data-section={section.kind}>
              <div className={CLASS.groupTitle} id={headingId} role="presentation">
                {section.kind === 'provider'
                  ? <><ProviderLogo id={section.provider ?? ''} name={providerById.get(section.provider ?? '')?.name ?? section.provider ?? ''} url={settings.providerIcons[section.provider ?? '']} size={12} />{providerById.get(section.provider ?? '')?.name ?? section.provider}</>
                  : t(section.kind === 'favorites' ? 'section.favorites' : 'section.recents')}
              </div>
              {section.entries.map((entry, index) => (
                <ModelRow
                  key={entry.key}
                  optionId={`${id}-${section.id}-${index}`}
                  entry={entry}
                  section={section}
                  active={activeOption?.id === `${id}-${section.id}-${index}`}
                  selected={props.selectedKeys.has(entry.key)}
                  favorite={favorites.has(entry.key)}
                  disabled={busy || (full && !props.selectedKeys.has(entry.key))}
                  showProvider={provider === undefined && section.kind !== 'provider'}
                  status={providerById.get(entry.provider)?.status ?? 'unknown'}
                  iconUrl={settings.providerIcons[entry.provider]}
                  t={t}
                  onHover={() => {
                    const at = flat.findIndex(option => option.id === `${id}-${section.id}-${index}`)
                    if (at !== active) setActive(at)
                  }}
                  onChoose={() => { choose(entry) }}
                  onToggleFavorite={() => { prefsStore.toggleFavorite(entry.key) }}
                />
              ))}
            </div>
          )
        })}
        {flat.length === 0 && state.status !== 'loading' && !loadError && (
          <div className={CLASS.empty}>
            {query.trim() !== ''
              ? (
                <>
                  <span>{t('empty.query', { query: query.trim() })}</span>
                  <span>
                    {provider !== undefined && <button type="button" className={CLASS.link} onClick={() => { setProvider(undefined); modelInputRef.current?.focus() }}>{t('empty.searchAll')}</button>}
                    <button type="button" className={CLASS.link} onClick={() => { setQuery(''); modelInputRef.current?.focus() }}>{t('empty.clear')}</button>
                  </span>
                </>
              )
              : provider !== undefined
                ? t('empty.provider', { provider: providerName ?? provider })
                : t('empty.models')}
          </div>
        )}
        {flat.length === 0 && state.status === 'loading' && <div className={CLASS.empty}>{t('status.loading')}</div>}
      </div>

      {effortChoices.length > 0 && (
        <div className={CLASS.effort} role="group" aria-label={t('effort.label')} onKeyDown={onEffortKeyDown}>
          <span className={CLASS.effortLabel} aria-hidden="true">{t('effort.label')}</span>
          {effortChoices.map((choice, index) => {
            const pressed = props.effectiveEffort === choice.effort
            return (
              <button
                key={choice.key}
                ref={(node) => { effortRefs.current[index] = node }}
                type="button"
                className={CLASS.effortOption}
                aria-pressed={pressed}
                tabIndex={-1}
                disabled={busy}
                data-effort={choice.effort ?? ''}
                onClick={() => { lastLoad.current = false; props.onEffort(choice.effort) }}
              >
                {choice.label}
              </button>
            )
          })}
        </div>
      )}

      {pick?.multiple === true && (
        <div className={CLASS.pickBar}>
          <span className={CLASS.pickCount} role="status" aria-live="polite" data-model-switcher-count={pick.count}>
            {pick.max === undefined
              ? t(pick.count === 1 ? 'pick.countOne' : 'pick.count', { count: pick.count })
              : t('pick.countOf', { count: pick.count, max: pick.max })}
          </span>
          <button
            ref={doneRef}
            type="button"
            className={CLASS.done}
            tabIndex={-1}
            disabled={pick.count === 0}
            data-model-switcher-done=""
            onClick={pick.onDone}
          >
            {t('pick.done')}
          </button>
        </div>
      )}

      {!narrow && (
        <div className={CLASS.hints} aria-hidden="true">
          <Hint keys={['↑', '↓']} label={t('hint.navigate')} />
          <Hint keys={['↵']} label={t(pick?.multiple === true ? 'hint.toggle' : 'hint.select')} />
          {pick?.multiple === true && <Hint keys={[isMac() ? '⌘' : 'Ctrl', '↵']} label={t('pick.done')} />}
          <Hint keys={['Tab']} label={t('hint.switch')} />
          <Hint keys={[isMac() ? '⌘' : 'Ctrl', 'S']} label={t('hint.favorite')} />
          <Hint keys={['Esc']} label={t('hint.close')} />
        </div>
      )}
    </div>
  )

  return createPortal(
    narrow
      ? <><div className={CLASS.scrim} aria-hidden="true" onClick={() => { props.onClose(true) }} />{surface}</>
      : surface,
    document.body,
  )
}

function countLabel(count: number, t: Translate): string {
  return count === 1 ? t('provider.countOne') : t('provider.count', { count })
}

function Hint({ keys, label }: { keys: readonly string[]; label: string }) {
  return <span>{keys.map(key => <kbd className={CLASS.kbd} key={key}>{key}</kbd>)}{label}</span>
}

function StatusTag({ status, message, t }: { status: ProviderStatus; message?: string | undefined; t: Translate }): ReactNode {
  if (status === 'unknown') return null
  return (
    <span className={CLASS.status} data-status={status} title={message}>
      {t(`status.${status}`)}
    </span>
  )
}

/** Props of one model option. */
interface ModelRowProps {
  readonly optionId: string
  readonly entry: ModelEntry
  readonly section: Section
  readonly active: boolean
  readonly selected: boolean
  readonly favorite: boolean
  readonly disabled: boolean
  readonly showProvider: boolean
  readonly status: ProviderStatus
  readonly iconUrl: string | undefined
  readonly t: Translate
  readonly onHover: () => void
  readonly onChoose: () => void
  readonly onToggleFavorite: () => void
}

function ModelRow(props: ModelRowProps) {
  const { entry, t } = props
  const meta = entry.meta
  const secondary = [entry.id !== entry.name ? entry.id : undefined, props.showProvider ? entry.providerName : undefined, entry.description]
    .filter((part): part is string => part !== undefined && part !== '')
  return (
    <div
      id={props.optionId}
      role="option"
      aria-selected={props.selected}
      aria-disabled={props.disabled || undefined}
      className={CLASS.option}
      data-active={props.active ? '' : undefined}
      data-selected={props.selected ? '' : undefined}
      data-model={entry.id}
      data-provider={entry.provider}
      title={entry.description === undefined ? entry.id : `${entry.id}\n${entry.description}`}
      onMouseMove={props.onHover}
      onClick={props.onChoose}
    >
      <ProviderLogo id={entry.provider} name={entry.providerName} url={props.iconUrl} />
      <span className={CLASS.optionMain}>
        <span className={CLASS.optionName}>{entry.name}</span>
        {secondary.length > 0 && <span className={CLASS.optionId}>{secondary.join(' · ')}</span>}
      </span>
      <span className={CLASS.badges}>
        {meta?.contextWindow !== undefined && (
          <span className={CLASS.badge} data-badge="context" aria-label={t('badge.contextAria', { tokens: meta.contextWindow })}>
            {formatTokens(meta.contextWindow)}
          </span>
        )}
        {meta?.vision === true && <span className={CLASS.badge} data-badge="vision">{t('badge.vision')}</span>}
        {entry.reasoning !== undefined && <span className={CLASS.badge} data-badge="reasoning">{t('badge.reasoning')}</span>}
        {props.status === 'needs-key' && <span className={CLASS.status} data-status="needs-key">{t('status.needs-key')}</span>}
      </span>
      {props.favorite && <span className={CLASS.srOnly}>{t('section.favorites')}</span>}
      <button
        type="button"
        className={CLASS.star}
        tabIndex={-1}
        aria-hidden="true"
        data-favorite={props.favorite ? '' : undefined}
        title={t(props.favorite ? 'favorite.remove' : 'favorite.add', { model: entry.name })}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggleFavorite()
        }}
      >
        <StarIcon filled={props.favorite} />
      </button>
      <span className={CLASS.check}>{props.selected ? <IconCheckOutlineRegular /> : null}</span>
    </div>
  )
}
