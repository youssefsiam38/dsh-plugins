/**
 * Settings shared by the Host half (which validates the bundle-row `config`)
 * and the browser half (which reads them from the page global the Host
 * publishes through `webserver/index-inject`).
 * @module dsh-model-switcher/settings
 */

/** Window global the Host half publishes before browser plugins activate. */
export const SETTINGS_GLOBAL = '__DSH_MODEL_SWITCHER__'

/** Where keyboard focus lands when the picker opens. */
export type InitialFocus = 'models' | 'providers'

/** Effective picker settings. */
export interface SwitcherSettings {
  /**
   * Shadowing rank of the composer registration in `conversation.input.model`.
   * The lowest priority renders; the stock control sits at 0.
   */
  readonly priority: number
  /** Where focus lands when the picker opens. */
  readonly initialFocus: InitialFocus
  /** How many recently picked models are listed on top; 0 turns the section off. */
  readonly recentLimit: number
  /** Whether the picker asks the Host for context windows and input types. */
  readonly metadata: boolean
  /** Whether the picker asks the Host which providers have their key stored. */
  readonly providerStatus: boolean
  /** Image URLs (http, https, or data:image) that override a provider's logo, by provider id. */
  readonly providerIcons: Readonly<Record<string, string>>
}

/** Settings used when the Host publishes none (for example an older Host half). */
export const DEFAULT_SETTINGS: SwitcherSettings = {
  priority: -10,
  initialFocus: 'models',
  recentLimit: 5,
  metadata: true,
  providerStatus: true,
  providerIcons: {},
}

/** Largest number of recents a user can ask for. */
export const MAX_RECENTS = 20

const ICON_URL = /^(?:https?:\/\/|data:image\/)/i

/**
 * Read the page global, keeping each valid field and falling back per field.
 * @param value - the raw global (untrusted page data).
 * @returns complete settings.
 */
export function parseSettings(value: unknown): SwitcherSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS
  const raw = value as Record<string, unknown>
  const priority = typeof raw['priority'] === 'number' && Number.isInteger(raw['priority']) && raw['priority'] < 0
    ? raw['priority'] : DEFAULT_SETTINGS.priority
  const initialFocus = raw['initialFocus'] === 'providers' || raw['initialFocus'] === 'models'
    ? raw['initialFocus'] : DEFAULT_SETTINGS.initialFocus
  const recentLimit = typeof raw['recentLimit'] === 'number' && Number.isInteger(raw['recentLimit'])
    && raw['recentLimit'] >= 0 && raw['recentLimit'] <= MAX_RECENTS
    ? raw['recentLimit'] : DEFAULT_SETTINGS.recentLimit
  const metadata = typeof raw['metadata'] === 'boolean' ? raw['metadata'] : DEFAULT_SETTINGS.metadata
  const providerStatus = typeof raw['providerStatus'] === 'boolean' ? raw['providerStatus'] : DEFAULT_SETTINGS.providerStatus
  const providerIcons: Record<string, string> = {}
  const icons = raw['providerIcons']
  if (typeof icons === 'object' && icons !== null) {
    for (const [provider, url] of Object.entries(icons)) {
      if (typeof url === 'string' && ICON_URL.test(url)) providerIcons[provider] = url
    }
  }
  return { priority, initialFocus, recentLimit, metadata, providerStatus, providerIcons }
}
