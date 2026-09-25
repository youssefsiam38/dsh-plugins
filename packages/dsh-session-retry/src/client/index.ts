/**
 * Browser half of `dsh-session-retry`: the retry block in the
 * `conversation.input.dock` list (full width, directly above the composer at
 * the end of the transcript). State arrives through
 * `useProjection('session-retry')`; Retry now and Stop run the logged
 * `/retry now` and `/retry stop` commands.
 * @module dsh-session-retry/client
 */

import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Session Controller client service (`ctx.sessions`).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the Conversation service and its input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Session standard `useProjection` seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `session-retry` SessionProjectionMap merge.
import type {} from '../types.ts'
import { RetryBlock, useRetryClock } from './RetryBlock.tsx'
import type { RetryActionResult, RetryBlockActions } from './RetryBlock.tsx'
import { en, zh } from './locales.ts'
import type { SessionRetryKey } from './locales.ts'
import { RETRY_BLOCK_CSS } from './styles.ts'

export { RetryBlock, formatRemaining, tickInterval, useRetryClock } from './RetryBlock.tsx'
export type { RetryActionResult, RetryBlockActions, RetryBlockProps } from './RetryBlock.tsx'
export { en, zh } from './locales.ts'
export type { SessionRetryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The session retry block's copy. */
    'session-retry': SessionRetryKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'session-retry'

/** Client plugin name. */
export const name = 'dsh-session-retry'

/** Services the block needs. */
export const inject = ['slots', 'sessions', 'locale']

/** Props the dock renders the block with. */
export type RetryDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<RetryBlockActions> & PropsLocale<'session-retry'>

/**
 * Dock adapter: reads the projection and ticks the countdown.
 * @param props - slot runtime props, injected actions, and the locale seat.
 * @returns the block, or nothing while no retry is pending.
 */
export function RetryDock({ useProjection, onRetryNow, onStop, t }: RetryDockProps) {
  const view = useProjection('session-retry')
  const now = useRetryClock(view)
  return createElement(RetryBlock, { view, now, t, onRetryNow, onStop })
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-retry: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = RETRY_BLOCK_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'session-retry: styles')

  const sessions = ctx.sessions
  const command = async (sessionId: SessionId, line: string): Promise<RetryActionResult> => {
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return { ok: false }
    const result = await binding.session.command(line)
    return result.ok && result.value.matched ? { ok: true } : { ok: false }
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'session-retry',
    order: 5,
    locale: NS,
    inject: (sessionId: SessionId): RetryBlockActions => ({
      onRetryNow: () => command(sessionId, '/retry now'),
      onStop: () => command(sessionId, '/retry stop'),
    }),
  }, RetryDock))
}
