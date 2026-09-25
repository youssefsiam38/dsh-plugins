/**
 * Settings shared by the Host half (which validates the bundle-row `config`)
 * and the browser half (which reads them from the page global the Host
 * publishes through `webserver/index-inject`).
 * @module dsh-command-menu/settings
 */

/** Window global the Host half publishes before browser plugins activate. */
export const SETTINGS_GLOBAL = '__DSH_COMMAND_MENU__'

/** Effective command menu settings. */
export interface MenuSettings {
  /**
   * Key combinations that open and close the menu, such as `Mod+K`.
   * `Mod` is Command on macOS and Control elsewhere.
   */
  readonly hotkeys: readonly string[]
  /** How many recently used entries the empty menu lists on top; 0 turns the section off. */
  readonly recentLimit: number
  /** Most rows one group shows while a query is typed. */
  readonly groupLimit: number
  /** Whether a typed query also searches message text through the Host session search. */
  readonly messageSearch: boolean
}

/** Settings used when the Host publishes none (for example an older Host half). */
export const DEFAULT_SETTINGS: MenuSettings = {
  hotkeys: ['Mod+K'],
  recentLimit: 5,
  groupLimit: 8,
  messageSearch: true,
}

/** Largest number of recents a user can ask for. */
export const MAX_RECENTS = 20

/** Largest per-group row limit. */
export const MAX_GROUP_LIMIT = 50

/** Modifier names a hotkey may use, in canonical order. */
export const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const

/** A hotkey: modifiers joined with `+`, then one key (a letter, digit, or a named key such as `Slash` or `F1`). */
export const HOTKEY_PATTERN = /^(?:(?:Mod|Ctrl|Meta|Alt|Shift)\+)*(?:[A-Za-z0-9]|F[1-9]|F1[0-2]|Slash|Period|Comma|Semicolon|Quote|BracketLeft|BracketRight|Backquote|Backslash|Minus|Equal|Space)$/

/**
 * Read the page global, keeping each valid field and falling back per field.
 * @param value - the raw global (untrusted page data).
 * @returns complete settings.
 */
export function parseSettings(value: unknown): MenuSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS
  const raw = value as Record<string, unknown>
  const hotkeys = Array.isArray(raw['hotkeys'])
    ? raw['hotkeys'].filter((key): key is string => typeof key === 'string' && HOTKEY_PATTERN.test(key))
    : DEFAULT_SETTINGS.hotkeys
  const integer = (key: string, min: number, max: number, fallback: number): number => {
    const found = raw[key]
    return typeof found === 'number' && Number.isInteger(found) && found >= min && found <= max ? found : fallback
  }
  return {
    hotkeys,
    recentLimit: integer('recentLimit', 0, MAX_RECENTS, DEFAULT_SETTINGS.recentLimit),
    groupLimit: integer('groupLimit', 1, MAX_GROUP_LIMIT, DEFAULT_SETTINGS.groupLimit),
    messageSearch: typeof raw['messageSearch'] === 'boolean' ? raw['messageSearch'] : DEFAULT_SETTINGS.messageSearch,
  }
}
