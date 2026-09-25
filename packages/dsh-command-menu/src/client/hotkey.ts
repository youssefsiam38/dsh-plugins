/**
 * Hotkey parsing and the global open/close gate. Keys match on
 * `KeyboardEvent.code` (the physical key), so a hotkey works the same under
 * every keyboard layout and while an input method is not composing.
 * @module dsh-command-menu/client/hotkey
 */

/** One parsed key combination. */
export interface Hotkey {
  /** `KeyboardEvent.code` of the main key, e.g. `KeyK`. */
  readonly code: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
  /** The source text, for display. */
  readonly text: string
}

/** The subset of `KeyboardEvent` the gate reads. */
export interface KeyInput {
  readonly code: string
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly isComposing: boolean
  readonly defaultPrevented: boolean
}

/**
 * Whether the platform uses Command as its primary modifier.
 * @param platform - `navigator.platform`/`userAgentData.platform` text.
 * @returns true on Apple platforms.
 */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

function codeOf(key: string): string {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return key
}

/**
 * Parse a hotkey such as `Mod+K` or `Ctrl+Shift+P`.
 * @param text - modifiers and one key joined with `+` (validated by the settings pattern).
 * @param apple - whether `Mod` means Command (true) or Control (false).
 * @returns the parsed combination.
 */
export function parseHotkey(text: string, apple: boolean): Hotkey {
  const parts = text.split('+')
  const key = parts.pop() ?? ''
  const has = (name: string): boolean => parts.includes(name)
  return {
    code: codeOf(key),
    ctrl: has('Ctrl') || (!apple && has('Mod')),
    meta: has('Meta') || (apple && has('Mod')),
    alt: has('Alt'),
    shift: has('Shift'),
    text,
  }
}

/**
 * Whether an event is exactly this combination (no extra modifiers).
 * @param hotkey - parsed combination.
 * @param event - keyboard event.
 * @returns true on a match.
 */
export function matchesHotkey(hotkey: Hotkey, event: KeyInput): boolean {
  return event.code === hotkey.code
    && event.ctrlKey === hotkey.ctrl && event.metaKey === hotkey.meta
    && event.altKey === hotkey.alt && event.shiftKey === hotkey.shift
}

/**
 * Decide whether a keydown toggles the menu. Another handler that already
 * took the key (`defaultPrevented`), an input method mid-composition, and a
 * held-down key all leave it alone, so a shortcut plugin or a text field
 * that binds the same combination keeps it.
 * @param hotkeys - parsed combinations.
 * @param event - keyboard event.
 * @returns true when the menu should toggle.
 */
export function isToggleEvent(hotkeys: readonly Hotkey[], event: KeyInput): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false
  return hotkeys.some(hotkey => matchesHotkey(hotkey, event))
}

/**
 * Keycap labels for a hotkey, platform-aware.
 * @param hotkey - parsed combination.
 * @param apple - whether to use the macOS symbols.
 * @returns one label per key.
 */
export function hotkeyLabels(hotkey: Hotkey, apple: boolean): string[] {
  const labels: string[] = []
  if (hotkey.ctrl) labels.push(apple ? '⌃' : 'Ctrl')
  if (hotkey.alt) labels.push(apple ? '⌥' : 'Alt')
  if (hotkey.shift) labels.push(apple ? '⇧' : 'Shift')
  if (hotkey.meta) labels.push(apple ? '⌘' : 'Meta')
  labels.push(hotkey.code.replace(/^(Key|Digit)/, ''))
  return labels
}
