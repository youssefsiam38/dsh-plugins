/**
 * Recently used entry ids, newest first, kept in this browser's
 * `localStorage` and shared between tabs through the `storage` event.
 * Only entry ids are stored (`session:<id>`, `command:<name>`, ...), never
 * titles or message text.
 * @module dsh-command-menu/client/recents
 */

/** Storage key. */
export const RECENTS_KEY = 'dsh-command-menu:recents'

/** Most ids kept. */
export const RECENTS_CAP = 40

/** Minimal `Storage` the store needs (tests pass a Map-backed one). */
export interface RecentsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Parse stored recents, dropping anything malformed.
 * @param text - stored JSON.
 * @returns ids, newest first.
 */
export function parseRecents(text: string | null): string[] {
  if (text === null) return []
  try {
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 512))].slice(0, RECENTS_CAP)
  } catch (error: unknown) {
    // Corrupt storage starts over empty.
    void error
    return []
  }
}

/** Observable recents list. */
export class RecentsStore {
  private ids: readonly string[]
  private readonly listeners = new Set<() => void>()

  /** @param storage - backing storage; undefined keeps recents in memory only. */
  constructor(private readonly storage: RecentsStorage | undefined) {
    this.ids = parseRecents(this.read())
  }

  /** @returns ids, newest first (stable until the next change). */
  getSnapshot = (): readonly string[] => this.ids

  /**
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Move an id to the front.
   * @param id - entry id.
   */
  touch(id: string): void {
    this.ids = [id, ...this.ids.filter(existing => existing !== id)].slice(0, RECENTS_CAP)
    this.write()
    this.emit()
  }

  /**
   * Remove ids, e.g. an archived session.
   * @param id - entry id.
   */
  forget(id: string): void {
    if (!this.ids.includes(id)) return
    this.ids = this.ids.filter(existing => existing !== id)
    this.write()
    this.emit()
  }

  /** Re-read storage after another tab wrote it. */
  reload(): void {
    this.ids = parseRecents(this.read())
    this.emit()
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(RECENTS_KEY) ?? null
    } catch (error: unknown) {
      // Storage blocked by the browser: recents stay in memory.
      void error
      return null
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(RECENTS_KEY, JSON.stringify(this.ids))
    } catch (error: unknown) {
      // Storage full or blocked: recents stay in memory for this page.
      void error
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
