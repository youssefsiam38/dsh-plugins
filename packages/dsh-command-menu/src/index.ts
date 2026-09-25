/**
 * Host half of `dsh-command-menu`. The menu itself runs in the browser
 * (`./client`); this half validates the bundle-row `config` and publishes it
 * to the page as the `__DSH_COMMAND_MENU__` global through
 * `webserver/index-inject`, before browser plugins activate. In a profile
 * without the Web server nothing listens for that event and the plugin is
 * inert.
 * @module dsh-command-menu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `webserver/index-inject` event declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_SETTINGS, HOTKEY_PATTERN, MAX_GROUP_LIMIT, MAX_RECENTS, SETTINGS_GLOBAL } from './settings.ts'
import type { MenuSettings } from './settings.ts'

export { DEFAULT_SETTINGS, HOTKEY_PATTERN, SETTINGS_GLOBAL, parseSettings } from './settings.ts'
export type { MenuSettings } from './settings.ts'

/** Plugin name (the bundle row's `name`). */
export const name = 'dsh-command-menu'

/** Bundle-row configuration; every field is optional. */
export interface Config {
  /** Key combinations that open the menu (`Mod` is Command on macOS, Control elsewhere). Default `[Mod+K]`. */
  hotkeys?: string[]
  /** Recently used entries listed on top of the empty menu (0 to 20; 0 turns the section off). Default 5. */
  recentLimit?: number
  /** Most rows one group shows while a query is typed (1 to 50). Default 8. */
  groupLimit?: number
  /** Search message text through the Host session search. Default true. */
  messageSearch?: boolean
}

/** Schema the Loader applies to the bundle row's `config`. */
export const Config: z<Config> = z.object({
  hotkeys: z.array(z.string().pattern(HOTKEY_PATTERN)).default([...DEFAULT_SETTINGS.hotkeys]),
  recentLimit: z.natural().max(MAX_RECENTS).default(DEFAULT_SETTINGS.recentLimit),
  groupLimit: z.natural().min(1).max(MAX_GROUP_LIMIT).default(DEFAULT_SETTINGS.groupLimit),
  messageSearch: z.boolean().default(DEFAULT_SETTINGS.messageSearch),
}) as z<Config>

/**
 * Resolve validated config into the settings the page receives.
 * @param config - Loader-validated config (schema defaults applied).
 * @returns the complete settings object.
 */
export function resolveSettings(config: Config): MenuSettings {
  return {
    hotkeys: [...config.hotkeys ?? DEFAULT_SETTINGS.hotkeys],
    recentLimit: config.recentLimit ?? DEFAULT_SETTINGS.recentLimit,
    groupLimit: config.groupLimit ?? DEFAULT_SETTINGS.groupLimit,
    messageSearch: config.messageSearch ?? DEFAULT_SETTINGS.messageSearch,
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
