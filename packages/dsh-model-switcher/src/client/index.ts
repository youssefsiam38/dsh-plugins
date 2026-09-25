/**
 * Browser half of `dsh-model-switcher`: registers the picker in the
 * composer's `conversation.input.model` seat at a negative priority, which
 * shadows the stock control (priority 0) while this plugin is loaded and
 * hands the seat back when it unloads. Data and writes go through the stock
 * plugin's per-session model directory (`ctx.modelDirectories`), so the
 * picker needs `@deepseek-ai/dsh-client-ui-model-selection` and stays inert
 * without it. Provider key status and model metadata come from optional
 * Remote reads (see `insights.ts`).
 * @module dsh-model-switcher/client
 */

import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Session Controller client service (`ctx.sessions`).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the composer's `conversation.input.model` seat declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the stock model-selection service (`ctx.modelDirectories`).
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `ctx.remote` merge and its forwarded-event keys.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SETTINGS_GLOBAL, parseSettings } from '../settings.ts'
import type { SwitcherSettings } from '../settings.ts'
import { ProviderInsights } from './insights.ts'
import type { InsightRemotes, WireResult } from './insights.ts'
import { en, zh } from './locales.ts'
import type { ModelSwitcherKey } from './locales.ts'
import { ModelSwitcher } from './ModelSwitcher.tsx'
import type { SwitcherFace, Translate } from './ModelSwitcher.tsx'
import { PrefsStore } from './prefs.ts'
import { MODEL_SWITCHER_CSS } from './styles.ts'

export { ModelSwitcher, SHEET_MEDIA } from './ModelSwitcher.tsx'
export type { DirectoryStore, DirectoryView, ModelSwitcherProps, SelectOutcome, SwitcherFace, Translate } from './ModelSwitcher.tsx'
export { ProviderInsights, apiKeyRefOf, collectMeta, parseRoutes } from './insights.ts'
export type { InsightOptions, InsightRemotes, InsightState, WireResult } from './insights.ts'
export { PREFS_KEY, PrefsStore, parsePrefs } from './prefs.ts'
export type { Prefs } from './prefs.ts'
export {
  buildSections, filterProviders, formatTokens, modelEntries, modelKey, providerEntries, rankModels, selectionOfKey,
} from './search.ts'
export type { ModelEntry, ModelMeta, ProviderEntry, ProviderStatus, RankPreferences, Section, SectionQuery } from './search.ts'
export { ProviderLogo, markOf } from './icons.tsx'
export { en, zh } from './locales.ts'
export type { ModelSwitcherKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The model picker's copy. */
    'model-switcher': ModelSwitcherKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'model-switcher'

/** Client plugin name. */
export const name = 'dsh-model-switcher'

/** Services the plugin needs before it registers anything. */
export const inject = ['slots', 'locale']

type SeatProps = InjectFace<SwitcherFace> & PropsLocale<'model-switcher'> & { locked: boolean }

function Seat(props: SeatProps) {
  return createElement(ModelSwitcher, { ...props, t: props.t as Translate })
}

/**
 * Read one Remote namespace service, if mounted.
 * @param ctx - client context.
 * @param namespace - Remote namespace name.
 * @returns the namespace's methods, or undefined.
 */
function namespaceOf(ctx: ClientContext, namespace: string): Record<string, unknown> | undefined {
  try {
    const service: unknown = ctx.get(`remote.${namespace}`)
    return typeof service === 'object' && service !== null ? service as Record<string, unknown> : undefined
  } catch (error: unknown) {
    // An unmounted namespace is an absent enrichment, not a failure.
    void error
    return undefined
  }
}

function method<A extends unknown[]>(target: Record<string, unknown> | undefined, key: string): ((...args: A) => Promise<WireResult<unknown>>) | undefined {
  const fn = target?.[key]
  return typeof fn === 'function' ? (...args: A) => (fn as (...a: A) => Promise<WireResult<unknown>>).apply(target, args) : undefined
}

/**
 * Bind the Remote reads the enrichment uses; each is absent when its namespace is.
 * @param ctx - client context.
 * @returns the bound calls.
 */
export function insightRemotes(ctx: ClientContext): InsightRemotes {
  const llm = namespaceOf(ctx, 'llm')
  const settings = namespaceOf(ctx, 'settings')
  const credentials = namespaceOf(ctx, 'credentials')
  const listConfigurableProviders = method<[]>(llm, 'listConfigurableProviders')
  const discoverModels = method<[string, { provider: string }]>(llm, 'discoverModels')
  const describeSettings = method<[]>(settings, 'describe')
  const describeCredentials = method<[string[]]>(credentials, 'describe')
  return {
    ...listConfigurableProviders === undefined ? {} : { listConfigurableProviders },
    ...discoverModels === undefined ? {} : { discoverModels },
    ...describeSettings === undefined ? {} : { describeSettings },
    ...describeCredentials === undefined ? {} : { describeCredentials },
  }
}

/**
 * Read the settings the Host half published.
 * @returns the effective settings.
 */
export function pageSettings(): SwitcherSettings {
  const page = globalThis as Partial<Record<typeof SETTINGS_GLOBAL, unknown>>
  return parseSettings(page[SETTINGS_GLOBAL])
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const settings = pageSettings()
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-switcher: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = MODEL_SWITCHER_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'model-switcher: styles')

  const prefs = new PrefsStore()
  ctx.effect(() => prefs.start(), 'model-switcher: favorites and recents')

  const insights = new ProviderInsights(() => insightRemotes(ctx), settings)
  ctx.effect(() => ctx.on('connection/reset', () => { insights.invalidate() }), 'model-switcher: connection generation')
  ctx.inject(['remote'], (remoteCtx) => {
    remoteCtx.effect(() => {
      const invalidate = (): void => { insights.invalidate() }
      const disposers = [
        remoteCtx.remote.$on('llm/adapters-updated', invalidate),
        remoteCtx.remote.$on('settings/document-updated', invalidate),
        remoteCtx.remote.$on('credentials/reference-updated', invalidate),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'model-switcher: pushed invalidations')
  })

  // `directoryFor` runs on the caller's context and reads `remote.session`, so
  // this scope declares the same Remote services the stock seat does.
  ctx.inject(['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session'], (scope) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      priority: settings.priority,
      locale: NS,
      registrant: name,
      inject: (sessionId: SessionId): SwitcherFace => {
        const directory = models.directoryFor(sessionId)
        const available = sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => { /* the store carries the failure */ })
          },
          select: selection => available ? directory.select(selection) : Promise.resolve(undefined),
          prefs,
          insights,
          settings,
        }
      },
    }, Seat))
  })
}
