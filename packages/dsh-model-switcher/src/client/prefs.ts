/**
 * Per-browser favorites and recents, kept in `localStorage` under one key
 * and shared across tabs through the `storage` event. Storage failures
 * (private windows, blocked site data) leave the lists in memory only.
 * @module dsh-model-switcher/client/prefs
 */

/** Storage key; the value is `{ favorites: string[], recents: string[] }` of row keys. */
export const PREFS_KEY = 'dsh-model-switcher:v1'

/** Recents kept in storage, independent of how many the picker shows. */
const STORED_RECENTS = 20

/** Favorites kept in storage. */
const STORED_FAVORITES = 200

/** Immutable preference snapshot. */
export interface Prefs {
  /** Favorite row keys, oldest first. */
  readonly favorites: readonly string[]
  /** Recently picked row keys, most recent first. */
  readonly recents: readonly string[]
}

const EMPTY: Prefs = { favorites: [], recents: [] }

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.includes('\u0000') && !out.includes(item)) out.push(item)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Parse a stored value (untrusted: another version or a user may have written it).
 * @param text - the raw stored string, or null when absent.
 * @returns the valid part of the stored preferences.
 */
export function parsePrefs(text: string | null): Prefs {
  if (text === null) return EMPTY
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return EMPTY
    const record = raw as Record<string, unknown>
    return { favorites: strings(record['favorites'], STORED_FAVORITES), recents: strings(record['recents'], STORED_RECENTS) }
  } catch (error: unknown) {
    // Unparseable storage is treated as empty; the next write replaces it.
    void error
    return EMPTY
  }
}

/** Observable preference store. */
export class PrefsStore {
  private snapshot: Prefs
  private readonly listeners = new Set<() => void>()
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== PREFS_KEY) return
    this.snapshot = parsePrefs(event.newValue)
    this.emit()
  }

  /** @param storage - where preferences persist; undefined keeps them in memory. */
  constructor(private readonly storage: Storage | undefined = defaultStorage()) {
    this.snapshot = this.read()
  }

  /** Start following writes from other tabs. @returns the stop function. */
  start(): () => void {
    window.addEventListener('storage', this.onStorage)
    return () => { window.removeEventListener('storage', this.onStorage) }
  }

  /** @returns the current snapshot (stable between changes). */
  getSnapshot = (): Prefs => this.snapshot

  /**
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Add or remove a favorite.
   * @param key - row key.
   */
  toggleFavorite(key: string): void {
    const favorites = this.snapshot.favorites.includes(key)
      ? this.snapshot.favorites.filter(item => item !== key)
      : [...this.snapshot.favorites, key].slice(-STORED_FAVORITES)
    this.write({ ...this.snapshot, favorites })
  }

  /**
   * Record a pick as the most recent.
   * @param key - row key.
   */
  pushRecent(key: string): void {
    const recents = [key, ...this.snapshot.recents.filter(item => item !== key)].slice(0, STORED_RECENTS)
    this.write({ ...this.snapshot, recents })
  }

  private read(): Prefs {
    try {
      return parsePrefs(this.storage?.getItem(PREFS_KEY) ?? null)
    } catch (error: unknown) {
      // Blocked site data: start empty and keep changes in memory.
      void error
      return EMPTY
    }
  }

  private write(next: Prefs): void {
    this.snapshot = next
    try {
      this.storage?.setItem(PREFS_KEY, JSON.stringify(next))
    } catch (error: unknown) {
      // Quota or blocked site data: the change lives for this page only.
      void error
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch (error: unknown) {
    // Accessing localStorage throws when the browser blocks site data.
    void error
    return undefined
  }
}
