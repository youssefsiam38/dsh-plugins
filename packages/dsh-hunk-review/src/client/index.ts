/**
 * Browser half of `dsh-hunk-review`:
 * - the `hunk-review` Turn data: each Turn's latest `workspace/changes` sequence;
 * - a "N files changed · Review" chip in `conversation.chat.turnTail`;
 * - the `hunk-review` right-Sidebar tab type that reviews one turn hunk by
 *   hunk, with Keep / Revert per hunk, per file, and for the whole turn.
 * @module dsh-hunk-review/client
 */

import { createElement, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: the Conversation service (`ctx.uiConversation`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the Chat turn-tail slot.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ReviewTarget } from '../types.ts'
import { en, zh } from './locales.ts'
import type { HunkReviewKey } from './locales.ts'
import { hunkReviewDefinition, parseReviewAddress, reviewAddress } from './node.ts'
import type { ReviewCoordinates } from './node.ts'
import { CLASS, ReviewPanel } from './ReviewPanel.tsx'
import { ReviewStore } from './store.ts'
import { HUNK_REVIEW_CSS } from './styles.ts'

export { CLASS, ReviewPanel } from './ReviewPanel.tsx'
export type { ReviewPanelProps } from './ReviewPanel.tsx'
export { CLIENT_ROUTES, ReviewStore } from './store.ts'
export type { ActionNotice, Fetcher, ReviewState, SummaryState } from './store.ts'
export { en, zh } from './locales.ts'
export type { HunkReviewKey } from './locales.ts'
export { hunkReviewDefinition, parseReviewAddress, REVIEW_ADDRESS, reviewAddress } from './node.ts'
export type { HunkReviewTurnData, ReviewCoordinates } from './node.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The hunk review tab and turn-tail chip copy. */
    'hunk-review': HunkReviewKey
  }
}

/** The file a review opens on. */
export interface HunkReviewParams {
  /** Index in the turn summary's files. */
  index?: number
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** The file a hunk review tab scrolls to. */
    'hunk-review': HunkReviewParams
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'hunk-review'

/** Client plugin name. */
export const name = 'dsh-hunk-review'

/** Services the plugin needs. */
export const inject = ['slots', 'locale']

/** The tab kind this plugin owns. */
export const TAB_KIND = 'hunk-review'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const TAB_ID = 'dsh-hunk-review'

/**
 * The review tab type.
 * @param t - namespace-bound translate.
 * @returns the definition to register.
 */
export function reviewTabDefinition(t: Translate<HunkReviewKey>): SidebarRightTabDefinition {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    patterns: ['dsh-resource://hunk-review/**'],
    canOpen: address => parseReviewAddress(address) !== undefined,
    title: (address) => {
      const turn = parseReviewAddress(address)?.turn
      return turn === undefined ? address : t('tab.title', { turn })
    },
  }
}

function useStoreVersion(store: ReviewStore): number {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.snapshot())
}

interface ChipFace {
  readonly store: ReviewStore
  readonly open: (coordinates: ReviewCoordinates) => void
}

type ChipProps = PropsRuntime<'conversation.chat.turnTail'> & InjectFace<ChipFace> & PropsLocale<'hunk-review'>

/**
 * The turn-tail chip: the number of files the turn changed and a way into the review.
 * @param props - closing Turn, Session, store, and copy.
 * @returns the chip, or null for a turn without recorded changes.
 */
function ReviewChip({ turn, sessionId, store, open, t }: ChipProps) {
  useStoreVersion(store)
  const data = turn.data.get('hunk-review')
  const summary = data === undefined ? undefined : store.summary(sessionId, data.seq)
  useEffect(() => {
    if (data !== undefined && summary === undefined) void store.loadSummary(sessionId, data.seq)
  }, [data, summary, sessionId, store])
  if (data === undefined || typeof summary !== 'object' || summary.total === 0) return null
  return createElement('button', {
    type: 'button',
    className: CLASS.chip,
    'data-hunk-review-chip': data.seq,
    'aria-label': t('chip.aria', { turn: summary.turn }),
    onClick: () => { open({ sessionId, seq: data.seq, turn: summary.turn }) },
  }, summary.total === 1 ? t('chip.labelOne') : t('chip.label', { count: summary.total }))
}

interface TabFace {
  readonly store: ReviewStore
}

type TabProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<TabFace> & PropsLocale<'hunk-review'>

/**
 * The review tab body.
 * @param props - tab information, store, and copy.
 * @returns the review panel.
 */
function ReviewTabBody({ useTabInfo, store, t }: TabProps) {
  useStoreVersion(store)
  const { tab } = useTabInfo()
  const coordinates = parseReviewAddress(tab.contentId)
  if (coordinates === undefined) throw new Error(`dsh-hunk-review: not a review address "${tab.contentId}"`)
  const { sessionId, seq } = coordinates
  const refresh = useCallback(() => { void store.loadReview(sessionId, seq) }, [store, sessionId, seq])
  useEffect(() => {
    if (tab.visible) refresh()
  }, [tab.visible, refresh])
  // Hosts before the page-command seam have no `bindCommands`; the panel's own Re-diff still works.
  const actions: Partial<typeof tab.actions> = tab.actions
  useEffect(() => actions.bindCommands?.({ refresh }), [actions, refresh])
  const params = tab.navigation.params as HunkReviewParams | undefined
  return createElement(ReviewPanel, {
    state: store.review(sessionId, seq),
    notice: store.notice(sessionId, seq),
    busy: store.busy(sessionId, seq),
    initialIndex: params?.index,
    onKeep: (target: ReviewTarget) => { void store.keep(sessionId, seq, target) },
    onRevert: (target: ReviewTarget) => { void store.revert(sessionId, seq, target) },
    onRefresh: refresh,
    t,
  })
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'hunk-review: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = HUNK_REVIEW_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'hunk-review: styles')
  const store = new ReviewStore()
  const t = ctx.locale.bind(NS)

  ctx.inject(['uiConversation'], (conversationCtx) => {
    conversationCtx.effect(() => conversationCtx.uiConversation.events.register(hunkReviewDefinition), 'hunk-review: turn data')
  })

  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sidebarCtx) => {
    sidebarCtx.effect(() => sidebarCtx.sidebarRightTabs.register(reviewTabDefinition(t)), 'hunk-review: tab type')
    sidebarCtx.effect(() => sidebarCtx.slots.inject('sidebar.right.pane.tab', () => sidebarCtx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: (): TabFace => ({ store }),
    }, ReviewTabBody)), 'hunk-review: tab body')
    sidebarCtx.effect(() => sidebarCtx.slots.inject('conversation.chat.turnTail', () => sidebarCtx.slots.register({
      name: 'conversation.chat.turnTail',
      id: TAB_ID,
      locale: NS,
      inject: (): ChipFace => ({
        store,
        open: (coordinates) => { sidebarCtx.sidebarRight.openResource(reviewAddress(coordinates)) },
      }),
    }, ReviewChip)), 'hunk-review: turn-tail chip')
  })
}
