/**
 * Browser half of `dsh-command-menu`:
 * - a window `keydown` listener that toggles the menu on the configured
 *   hotkeys (default Cmd+K on macOS, Ctrl+K elsewhere), yielding to any
 *   handler that already took the key;
 * - the menu itself in the frame-wide `shell.overlay` layer;
 * - a search button in `sidebar.footer.action`, the way in on touch screens.
 * Data and actions go through the loaded client services (see `host.ts`).
 * @module dsh-command-menu/client
 */

import { createElement, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `shell.overlay` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `sidebar.footer.action` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SETTINGS_GLOBAL, parseSettings } from '../settings.ts'
import type { MenuSettings } from '../settings.ts'
import { CLASS } from './classes.ts'
import { CommandMenu } from './CommandMenu.tsx'
import type { Translate } from './entries.ts'
import { hotkeyLabels, isApplePlatform, isToggleEvent, parseHotkey } from './hotkey.ts'
import type { Hotkey } from './hotkey.ts'
import { MenuHost } from './host.ts'
import { en, zh } from './locales.ts'
import type { CommandMenuKey } from './locales.ts'
import type { MenuEntry, PageId } from './model.ts'
import { RecentsStore, RECENTS_KEY } from './recents.ts'
import { COMMAND_MENU_CSS } from './styles.ts'

export { CommandMenu, SHEET_MEDIA, highlight } from './CommandMenu.tsx'
export type { CommandMenuProps } from './CommandMenu.tsx'
export { buildEntries, messageEntries, relativeAge, themeLabel, EMPTY_FACTS } from './entries.ts'
export type { MenuFacts, MessageHit, Translate } from './entries.ts'
export { hotkeyLabels, isApplePlatform, isToggleEvent, matchesHotkey, parseHotkey } from './hotkey.ts'
export type { Hotkey, KeyInput } from './hotkey.ts'
export { MenuHost, findTextElement } from './host.ts'
export type { RunOutcome } from './host.ts'
export { buildSections, flatten, moveActive, parseQuery, rankEntries, PREFIXES } from './model.ts'
export type { MenuEntry, PageId, ParsedQuery, Scope, Section } from './model.ts'
export { RecentsStore, parseRecents, RECENTS_KEY } from './recents.ts'
export { en, zh } from './locales.ts'
export type { CommandMenuKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The command menu's copy. */
    'command-menu': CommandMenuKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'command-menu'

/** Client plugin name. */
export const name = 'dsh-command-menu'

/** Services the plugin needs before it registers anything. */
export const inject = ['slots', 'locale']

/** How long a notice stays on screen, in ms. */
export const NOTICE_MS = 6000

/** Open state and the transient notice. */
interface ViewState {
  readonly open: boolean
  readonly page: PageId
  readonly notice?: { readonly text: string; readonly seq: number }
}

/** The menu's open/close controller. */
export class MenuController {
  private state: ViewState = { open: false, page: 'root' }
  private readonly listeners = new Set<() => void>()
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private seq = 0

  /** @param onOpen - called each time the menu opens. */
  constructor(private readonly onOpen: () => void) {}

  getSnapshot = (): ViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Open the menu.
   * @param page - the page to open on.
   */
  open(page: PageId = 'root'): void {
    if (this.state.open) return
    this.onOpen()
    this.set({ open: true, page })
  }

  close(): void {
    if (this.state.open) this.set({ open: false, page: 'root' })
  }

  toggle(): void {
    if (this.state.open) this.close()
    else this.open()
  }

  /**
   * Show a notice for {@link NOTICE_MS}.
   * @param text - notice text.
   */
  notify(text: string): void {
    clearTimeout(this.noticeTimer)
    this.set({ notice: { text, seq: ++this.seq } })
    this.noticeTimer = setTimeout(() => { this.set({ notice: undefined }) }, NOTICE_MS)
  }

  dispose(): void {
    clearTimeout(this.noticeTimer)
  }

  private set(patch: Partial<ViewState>): void {
    const next = { ...this.state, ...patch }
    if (patch.notice === undefined && 'notice' in patch) delete (next as { notice?: unknown }).notice
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** Injected face of the overlay. */
interface OverlayFace {
  readonly controller: MenuController
  readonly host: MenuHost
  readonly recents: RecentsStore
  readonly settings: MenuSettings
  readonly hotkeyKeys: readonly string[]
  run(entry: MenuEntry, query: string): void
}

/** Injected face of the sidebar button. */
interface TriggerFace {
  readonly controller: MenuController
  readonly hotkeyKeys: readonly string[]
}

type OverlayProps = InjectFace<OverlayFace> & PropsLocale<'command-menu'>
type TriggerProps = InjectFace<TriggerFace> & PropsLocale<'command-menu'> & { wide: boolean }

function Overlay(props: OverlayProps) {
  const { controller, host, recents, settings } = props
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const facts = useSyncExternalStore(host.subscribe, host.getSnapshot)
  const recentIds = useSyncExternalStore(recents.subscribe, recents.getSnapshot)
  const t = props.t as Translate
  return createElement('div', { style: { display: 'contents' } },
    createElement(CommandMenu, {
      open: state.open,
      facts,
      settings,
      recents: recentIds,
      t,
      hotkeyKeys: props.hotkeyKeys,
      initialPage: state.page,
      searchMessages: host.searchMessages,
      onRun: props.run,
      onPage: (page: PageId) => { if (page === 'models') host.prepare() },
      onClose: () => { controller.close() },
    }),
    state.notice === undefined
      ? null
      : createElement('div', { key: state.notice.seq, className: CLASS.toast, role: 'status', 'data-command-menu-notice': '' }, state.notice.text),
  )
}

function Trigger({ controller, hotkeyKeys, wide, t }: TriggerProps) {
  return createElement('button', {
    type: 'button',
    'data-command-menu-trigger': '',
    'aria-label': (t as Translate)('title'),
    'aria-haspopup': 'dialog',
    title: `${(t as Translate)('title')} (${hotkeyKeys.join('')})`,
    onClick: () => { controller.open() },
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: wide ? '0 8px' : 0,
      width: wide ? undefined : 32, justifyContent: 'center', border: 'none', borderRadius: 8, background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer',
    },
  },
  createElement(IconSearchOutlineRegular, { size: 16 }),
  wide ? createElement('span', { className: CLASS.keys }, ...hotkeyKeys.map(key => createElement('kbd', { key, className: CLASS.kbd }, key))) : null)
}

/**
 * Read the settings the Host half published.
 * @returns the effective settings.
 */
export function pageSettings(): MenuSettings {
  const page = globalThis as Partial<Record<typeof SETTINGS_GLOBAL, unknown>>
  return parseSettings(page[SETTINGS_GLOBAL])
}

function platformText(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined
  return nav?.userAgentData?.platform ?? nav?.platform ?? nav?.userAgent ?? ''
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch (error: unknown) {
    // Storage access denied (privacy mode): recents live in memory.
    void error
    return undefined
  }
}

/** Whether the key target opted out of the global hotkey. */
function optedOut(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-command-menu-ignore]') !== null
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const settings = pageSettings()
  const apple = isApplePlatform(platformText())
  const hotkeys: Hotkey[] = settings.hotkeys.map(text => parseHotkey(text, apple))
  const firstHotkey = hotkeys[0]
  const hotkeyKeys = firstHotkey === undefined ? [] : hotkeyLabels(firstHotkey, apple)

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'command-menu: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = COMMAND_MENU_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'command-menu: styles')

  const t = ctx.locale.bind(NS)
  const locale = ctx.locale
  const bindLoose = (ns: string): ((key: string) => string) => (locale.bind as (ns: string) => (key: string) => string).call(locale, ns)
  const host = new MenuHost(ctx, {
    matchNotFound: title => t('notice.matchNotFound', { title }),
    failed: reason => t('notice.failed', { reason }),
    settingsUnavailable: t('notice.settingsUnavailable'),
    settingsTrigger: () => {
      try {
        const label = bindLoose('settings')('trigger')
        return label === '' || label === 'trigger' ? undefined : label
      } catch (error: unknown) {
        // The settings dictionary is not registered in this composition.
        void error
        return undefined
      }
    },
  })
  ctx.effect(() => host.start(), 'command-menu: sources')
  const recents = new RecentsStore(browserStorage())
  ctx.effect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === RECENTS_KEY) recents.reload() }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage) }
  }, 'command-menu: recents across tabs')

  const controller = new MenuController(() => { host.prepare() })
  ctx.effect(() => () => { controller.dispose() }, 'command-menu: controller')

  const run = (entry: MenuEntry, query: string): void => {
    recents.touch(entry.kind === 'message' ? `session:${entry.ref ?? ''}` : entry.id)
    controller.close()
    // Let the dialog unmount and hand focus back before the action moves it.
    setTimeout(() => {
      void host.run(entry, query).then((outcome) => {
        if (outcome.kind === 'notice') controller.notify(outcome.text)
      })
    }, 0)
  }

  if (hotkeys.length > 0) {
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (!isToggleEvent(hotkeys, event) || optedOut(event.target)) return
        event.preventDefault()
        controller.toggle()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => { window.removeEventListener('keydown', onKeyDown) }
    }, 'command-menu: hotkey')
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'command-menu',
    locale: NS,
    inject: (): OverlayFace => ({ controller, host, recents, settings, hotkeyKeys, run }),
  }, Overlay))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'command-menu',
    order: 50,
    locale: NS,
    inject: (): TriggerFace => ({ controller, hotkeyKeys }),
  }, Trigger))
}
