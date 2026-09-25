/**
 * Host half of `dsh-model-switcher`. The picker itself runs in the browser
 * (`./client`); this half validates the bundle-row `config` and publishes it
 * to the page as the `__DSH_MODEL_SWITCHER__` global through
 * `webserver/index-inject`, before browser plugins activate. In a profile
 * without the Web server nothing listens for that event and the plugin is
 * inert.
 * @module dsh-model-switcher
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `webserver/index-inject` event declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_SETTINGS, MAX_RECENTS, SETTINGS_GLOBAL } from './settings.ts'
import type { InitialFocus, SwitcherSettings } from './settings.ts'

export { DEFAULT_SETTINGS, SETTINGS_GLOBAL, parseSettings } from './settings.ts'
export type { InitialFocus, SwitcherSettings } from './settings.ts'

/** Plugin name (the bundle row's `name`). */
export const name = 'dsh-model-switcher'

/** Bundle-row configuration; every field is optional. */
export interface Config {
  /** Shadowing rank in `conversation.input.model` (negative; the stock control is 0). Default -10. */
  priority?: number
  /** Where focus lands when the picker opens. Default `models`. */
  initialFocus?: InitialFocus
  /** Recently picked models listed on top (0 to 20; 0 turns the section off). Default 5. */
  recentLimit?: number
  /** Ask the Host for context windows and input types. Default true. */
  metadata?: boolean
  /** Ask the Host which providers have their key stored. Default true. */
  providerStatus?: boolean
  /** Logo URL overrides by provider id (http, https, or data:image URLs). */
  providerIcons?: Record<string, string>
}

/** Schema the Loader applies to the bundle row's `config`. */
export const Config: z<Config> = z.object({
  priority: z.number().step(1).min(-1000).max(-1).default(DEFAULT_SETTINGS.priority),
  initialFocus: z.union(['models', 'providers'] as const).default(DEFAULT_SETTINGS.initialFocus),
  recentLimit: z.natural().max(MAX_RECENTS).default(DEFAULT_SETTINGS.recentLimit),
  metadata: z.boolean().default(DEFAULT_SETTINGS.metadata),
  providerStatus: z.boolean().default(DEFAULT_SETTINGS.providerStatus),
  providerIcons: z.dict(z.string().pattern(/^(?:https?:\/\/|data:image\/)/i)).default({}),
}) as z<Config>

/**
 * Resolve validated config into the settings the page receives.
 * @param config - Loader-validated config (schema defaults applied).
 * @returns the complete settings object.
 */
export function resolveSettings(config: Config): SwitcherSettings {
  return {
    priority: config.priority ?? DEFAULT_SETTINGS.priority,
    initialFocus: config.initialFocus ?? DEFAULT_SETTINGS.initialFocus,
    recentLimit: config.recentLimit ?? DEFAULT_SETTINGS.recentLimit,
    metadata: config.metadata ?? DEFAULT_SETTINGS.metadata,
    providerStatus: config.providerStatus ?? DEFAULT_SETTINGS.providerStatus,
    providerIcons: { ...config.providerIcons ?? {} },
  }
}

/**
 * Publish the settings to every served page.
 * @param ctx - Host context.
 * @param config - Loader-validated config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveSettings(config)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: SETTINGS_GLOBAL, value: settings })
  })
}
