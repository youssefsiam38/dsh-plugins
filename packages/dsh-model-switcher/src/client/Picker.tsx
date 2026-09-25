/**
 * Picker mode of the switcher surface, opened by `modelSwitcher.pick`: the
 * same provider select, model search, badges, favorites, keyboard, and phone
 * sheet as the composer control, over the Host catalog, without writing any
 * session's model. A single pick settles on the first chosen row; a multiple
 * pick toggles checks and settles on Done.
 * @module dsh-model-switcher/client/Picker
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MutableRefObject } from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelRef } from '../service.ts'
import type { SwitcherSettings } from '../settings.ts'
import type { ProviderInsights } from './insights.ts'
import { SwitcherPanel } from './ModelSwitcher.tsx'
import type { DirectoryStore, DirectoryView, PanelPlacement, Translate } from './ModelSwitcher.tsx'
import type { PrefsStore } from './prefs.ts'
import { modelKey, selectionOfKey } from './search.ts'

/** A normalized pick request. */
export interface PickRequest {
  readonly anchor: HTMLElement | undefined
  readonly multiple: boolean
  /** Most checked models; undefined means unlimited. */
  readonly max: number | undefined
  readonly exclude: readonly ModelRef[]
  readonly initial: readonly ModelRef[]
  readonly title: string | undefined
}

/** Props of {@link ModelPicker}. */
export interface ModelPickerProps {
  readonly request: PickRequest
  readonly catalog: DirectoryStore
  readonly load: () => void
  readonly prefs: PrefsStore
  readonly insights: ProviderInsights
  readonly settings: SwitcherSettings
  readonly t: Translate
  /** Called once: the picked models, or undefined on cancel. */
  readonly onSettle: (result: ModelRef[] | undefined) => void
}

/** A form control's anchor opens the popover below it, left-aligned. */
const PICK_PLACEMENT: PanelPlacement = { side: 'bottom', align: 'start' }

/**
 * Leave excluded models out of the catalog view (and drop groups left empty).
 * @param view - the catalog snapshot.
 * @param exclude - row keys to hide.
 * @returns the filtered view.
 */
export function withoutExcluded(view: DirectoryView, exclude: ReadonlySet<string>): DirectoryView {
  if (exclude.size === 0) return view
  const groups = view.groups
    .map(group => ({ ...group, models: group.models.filter(model => !exclude.has(modelKey(group.id, model.id))) }))
    .filter(group => group.models.length > 0)
  return { ...view, groups }
}

/**
 * Render the picker surface for one request.
 * @param props - the request, the catalog, shared stores, and the settle callback.
 * @returns the portaled surface.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { request, catalog, load, t, onSettle } = props
  const raw = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const exclude = useMemo(() => new Set(request.exclude.map(ref => modelKey(ref.provider, ref.model))), [request.exclude])
  const view = useMemo(() => withoutExcluded(raw, exclude), [raw, exclude])
  const [checked, setChecked] = useState<readonly string[]>(() => {
    if (!request.multiple) return []
    const keys = request.initial.map(ref => modelKey(ref.provider, ref.model)).filter(key => !exclude.has(key))
    return [...new Set(keys)].slice(0, request.max)
  })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<HTMLElement | null>(request.anchor ?? null)
  const settled = useRef(false)
  const id = useId()

  const settle = useCallback((result: ModelRef[] | undefined, restoreFocus: boolean): void => {
    if (settled.current) return
    settled.current = true
    onSettle(result)
    if (restoreFocus) queueMicrotask(() => { request.anchor?.focus() })
  }, [onSettle, request.anchor])

  useEffect(() => { load() }, [load])
  // An outside pointer cancels. The anchor counts as inside, so the caller's own click can toggle.
  useDismissOnOutsidePointer(anchorRef as MutableRefObject<HTMLElement | null>, true, (open) => {
    if (!open) settle(undefined, false)
  }, panelRef)

  const refs = (keys: readonly string[]): ModelRef[] => keys.map((key) => {
    const { provider, model } = selectionOfKey(key)
    return { provider, model }
  })

  return (
    <SwitcherPanel
      id={`${id}-pick`}
      panelRef={panelRef}
      anchorRef={anchorRef}
      placement={PICK_PLACEMENT}
      state={view}
      selectedKeys={new Set(checked)}
      title={request.title ?? t(request.multiple ? 'pick.titleMany' : 'pick.titleOne')}
      pick={{
        multiple: request.multiple,
        count: checked.length,
        max: request.max,
        onDone: () => { if (checked.length > 0) settle(refs(checked), true) },
      }}
      load={load}
      prefs={props.prefs}
      insights={props.insights}
      settings={props.settings}
      effortLabel={undefined}
      effectiveEffort={undefined}
      t={t}
      onClose={(restoreFocus) => { settle(undefined, restoreFocus) }}
      onChoose={(entry) => {
        if (!request.multiple) {
          settle(refs([entry.key]), true)
          return
        }
        setChecked((current) => {
          if (current.includes(entry.key)) return current.filter(key => key !== entry.key)
          if (request.max !== undefined && current.length >= request.max) return current
          return [...current, entry.key]
        })
      }}
      onEffort={() => {}}
    />
  )
}
