/**
 * Read-only view of the favorites and recents that `dsh-model-switcher`
 * keeps in `localStorage`, so both pickers list the same models first. This
 * plugin never writes them. Row keys are `provider \0 model`.
 */

/** Storage key and value layout owned by `dsh-model-switcher`. */
export const SWITCHER_PREFS_KEY = 'dsh-model-switcher:v1'

/** Favorite and recent models, as provider/model pairs. */
export interface SwitcherPrefs {
  readonly favorites: readonly { readonly provider: string; readonly model: string }[]
  readonly recents: readonly { readonly provider: string; readonly model: string }[]
}

const EMPTY: SwitcherPrefs = { favorites: [], recents: [] }

function pairs(value: unknown): Array<{ provider: string; model: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((key: unknown) => {
    if (typeof key !== 'string') return []
    const split = key.indexOf('\u0000')
    if (split <= 0 || split === key.length - 1) return []
    return [{ provider: key.slice(0, split), model: key.slice(split + 1) }]
  })
}

/**
 * Parse the stored value.
 * @param raw - stored JSON, or null.
 * @returns the preferences; empty when absent or malformed.
 */
export function parseSwitcherPrefs(raw: string | null): SwitcherPrefs {
  if (raw === null) return EMPTY
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return EMPTY
    const fields = parsed as Record<string, unknown>
    return { favorites: pairs(fields['favorites']), recents: pairs(fields['recents']) }
  } catch (error: unknown) {
    // Malformed storage belongs to the other plugin; show no shortcuts.
    void error
    return EMPTY
  }
}

/**
 * Read the switcher's preferences from this browser.
 * @param storage - storage to read; `localStorage` by default.
 * @returns the preferences.
 */
export function readSwitcherPrefs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): SwitcherPrefs {
  try {
    return parseSwitcherPrefs(storage?.getItem(SWITCHER_PREFS_KEY) ?? null)
  } catch (error: unknown) {
    // Storage can throw (disabled cookies, sandboxed frames).
    void error
    return EMPTY
  }
}
