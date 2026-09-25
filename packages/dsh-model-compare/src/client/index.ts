/**
 * Browser half of `dsh-model-compare`:
 * - the `model-compare` entry of the `conversation.view` list (a Compare tab
 *   beside Chat in every session header): the setup form, then one column
 *   per lane;
 * - the session-scoped `model-compare.lane` slot, rendered inside a
 *   `SessionProvider` bound to each lane's explicit `SessionReference`; it
 *   shows the lane's statistics (`useProjection('model-compare')`) and a
 *   compact transcript folded from the lane's event window (see
 *   `./transcript.ts` for why the stock Chat view is not embedded).
 * @module dsh-model-compare/client
 */

import { createElement, useCallback, useMemo } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the Session Controller client service (`ctx.sessions`).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `conversation.view` / `conversation.session` slot rows.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Session standard props (`useSession`, `useProjection`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `model-compare` projection map entries.
import type {} from '../projection-map.ts'
import { CompareApi } from './api.ts'
import { CompareView } from './CompareView.tsx'
import type { CompareDeps } from './CompareView.tsx'
import { LaneView } from './Lane.tsx'
import type { LaneOwnerProps } from './Lane.tsx'
import { en, zh } from './locales.ts'
import type { ModelCompareKey } from './locales.ts'
import { readSwitcherPrefs } from './prefs.ts'
import { foldTranscript } from './transcript.ts'
import { MODEL_COMPARE_CSS } from './styles.ts'

export { CompareApi, CLIENT_ROUTES } from './api.ts'
export type { ApiResult, Fetcher } from './api.ts'
export { CompareView, NARROW_MEDIA } from './CompareView.tsx'
export type { CompareDeps, CompareViewProps } from './CompareView.tsx'
export { LaneStats, LaneView, laneStatus } from './Lane.tsx'
export type { LaneOwnerProps, LaneViewProps } from './Lane.tsx'
export { Setup, catalogRows, listRows } from './Setup.tsx'
export type { ModelRow, Picked, SetupProps, Translate } from './Setup.tsx'
export { parseSwitcherPrefs, readSwitcherPrefs, SWITCHER_PREFS_KEY } from './prefs.ts'
export type { SwitcherPrefs } from './prefs.ts'
export { seconds, tokens, usd } from './format.ts'
export { en, zh } from './locales.ts'
export { foldTranscript } from './transcript.ts'
export type { TranscriptItem, WindowEntry } from './transcript.ts'
export { Transcript } from './Transcript.tsx'
export type { ModelCompareKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'model-compare'

/** `conversation.view` entry id (the Compare tab). */
export const VIEW_ID = 'model-compare'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Compare view copy. */
    'model-compare': ModelCompareKey
  }
  interface SlotMap {
    /** One comparison lane, rendered inside the lane session's scope. */
    'model-compare.lane': { kind: 'single'; scope: 'session'; owner: LaneOwnerProps }
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A lane column of the Compare view. */
    modelCompare: unknown
  }
}

/** Client plugin name. */
export const name = 'dsh-model-compare'

/** Services the plugin needs. */
export const inject = ['slots', 'sessions', 'locale']

/** Injected face of the Compare view. */
interface ViewFace {
  deps: CompareDeps
}

type ViewProps = PropsRuntime<'conversation.view'> & PropsRenderSlots<'model-compare.lane'> & InjectFace<ViewFace> & PropsLocale<'model-compare'>
/** Injected face of a lane: its event window. */
interface LaneFace {
  hooks: { events: SessionEventSource }
}

type LaneProps = PropsRuntime<'model-compare.lane'> & InjectFace<LaneFace> & PropsLocale<'model-compare'>

function CompareEntry({ sessionId, SessionProvider, renderSlot, deps, t }: ViewProps) {
  const renderLane = useCallback((reference: SessionReference, owner: LaneOwnerProps) => createElement(
    SessionProvider,
    { session: reference, children: renderSlot('model-compare.lane', owner) },
  ), [SessionProvider, renderSlot])
  return createElement(CompareView, { sessionId, deps, renderLane, t })
}

function LaneEntry(props: LaneProps) {
  const { useSession, useProjection, useEvents, t } = props
  const entries = useEvents((window: SessionEventWindow) => window.entries)
  const items = useMemo(() => foldTranscript(entries), [entries])
  const running = useSession((snapshot: SessionSnapshot) => snapshot.running)
  const loading = useSession((snapshot: SessionSnapshot) => snapshot.openState === 'loading' && snapshot.blank)
  const stats = useProjection('model-compare')
  return createElement(LaneView, {
    lane: props.lane,
    index: props.index,
    locked: props.locked,
    adopting: props.adopting,
    onAdopt: props.onAdopt,
    onStop: props.onStop,
    stats,
    running,
    loading,
    items,
    t,
  })
}

/** Navigation face of the Web workspace UI, read structurally (the package is optional). */
interface WorkspaceNavigation {
  openSession(target: SessionId): void
}

function isNavigation(value: unknown): value is WorkspaceNavigation {
  return typeof value === 'object' && value !== null && typeof (value as { openSession?: unknown }).openSession === 'function'
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-compare: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = MODEL_COMPARE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'model-compare: styles')
  const t = ctx.locale.bind(NS)

  const deps: CompareDeps = {
    api: new CompareApi(),
    prefs: () => readSwitcherPrefs(),
    retain: sessionId => ctx.sessions.retain(sessionId as SessionId, { source: 'modelCompare' }),
    open: (sessionId) => {
      const navigation: unknown = ctx.get('uiWorkspace' as never)
      if (!isNavigation(navigation)) return false
      navigation.openSession(sessionId as SessionId)
      return true
    },
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: 30,
    locale: NS,
    label: () => t('view.label'),
    children: {
      'model-compare.lane': { kind: 'single', scope: 'session' },
    },
    inject: (): ViewFace => ({ deps }),
  }, CompareEntry))
  ctx.slots.inject('model-compare.lane', () => ctx.slots.register({
    name: 'model-compare.lane',
    locale: NS,
    inject: (sessionId: SessionId): LaneFace => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`dsh-model-compare: lane session "${sessionId}" is not retained`)
      return { hooks: { events: binding.eventSource } }
    },
  }, LaneEntry))
}
