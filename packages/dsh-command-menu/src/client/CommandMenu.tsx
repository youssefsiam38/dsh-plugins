/**
 * The command menu surface: a modal dialog holding one search field
 * (`role="combobox"`) over a grouped listbox, following the WAI-ARIA APG
 * combobox pattern: DOM focus stays in the field and
 * `aria-activedescendant` names the active option. Rows that open a nested
 * page ("Switch model ›") push it onto a page stack; Backspace in an empty
 * field or Escape goes back one page. On narrow screens the dialog becomes a
 * full-screen sheet with a close button.
 * @module dsh-command-menu/client/CommandMenu
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuSettings } from '../settings.ts'
import { CLASS } from './classes.ts'
import { SEARCH_OFF, buildEntries, messageEntries, pageLabel } from './entries.ts'
import type { MenuFacts, MessageHit, Translate } from './entries.ts'
import { MenuIcon } from './icons.tsx'
import type { CommandMenuKey } from './locales.ts'
import { buildSections, flatten, moveActive, parseQuery } from './model.ts'
import type { GroupId, MenuEntry, PageId, Scope } from './model.ts'

/** Media query under which the menu renders as a full-screen sheet. */
export const SHEET_MEDIA = '(max-width: 640px)'

/** Shortest query that starts a message search. */
export const MESSAGE_SEARCH_MIN = 2

/** Debounce before a message search starts, in ms. */
export const MESSAGE_SEARCH_DELAY = 200

/** Props of {@link CommandMenu}. */
export interface CommandMenuProps {
  readonly open: boolean
  readonly facts: MenuFacts
  readonly settings: MenuSettings
  /** Recently used entry ids, newest first. */
  readonly recents: readonly string[]
  readonly t: Translate
  /** Keycaps of the opening hotkey, for the footer. */
  readonly hotkeyKeys: readonly string[]
  /** Page the menu opens on (default `root`). */
  readonly initialPage?: PageId
  /** Full-text search; absent disables the Messages group. */
  readonly searchMessages?: (text: string, signal: AbortSignal) => Promise<readonly MessageHit[]>
  /** Run an entry that does not open a page; the owner closes the menu. */
  onRun(entry: MenuEntry, query: string): void
  /** A nested page opened (the owner may start loading its rows). */
  onPage?(page: PageId): void
  onClose(): void
}

type MessageState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly text: string }
  | { readonly status: 'ready'; readonly text: string; readonly hits: readonly MessageHit[] }
  | { readonly status: 'error'; readonly text: string; readonly message: string }
  | { readonly status: 'off'; readonly text: string }

const IDLE: MessageState = { status: 'idle' }

function useSheet(): boolean {
  const query = typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? undefined : window.matchMedia(SHEET_MEDIA)
  const [sheet, setSheet] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (query === undefined) return
    const update = (): void => { setSheet(query.matches) }
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [query])
  return sheet
}

/**
 * Split text around case-insensitive occurrences of the query terms.
 * @param text - displayed text.
 * @param terms - lowercase query terms.
 * @returns text with `<mark>` around matches.
 */
export function highlight(text: string, terms: readonly string[]): ReactNode {
  const useful = terms.filter(term => term.length > 0)
  if (useful.length === 0) return text
  const pattern = new RegExp(`(${useful.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const parts = text.split(pattern)
  return parts.map((part, index) => index % 2 === 1 ? <mark key={index} className={CLASS.mark}>{part}</mark> : part)
}

const GROUP_LABEL: Record<GroupId, CommandMenuKey> = {
  recent: 'group.recent',
  actions: 'group.actions',
  sessions: 'group.sessions',
  messages: 'group.messages',
  commands: 'group.commands',
  workspaces: 'group.workspaces',
  models: 'group.models',
  settings: 'group.settings',
  themes: 'group.themes',
  scopes: 'group.scopes',
}

const SCOPE_BADGE: Record<Exclude<Scope, 'all'>, CommandMenuKey> = {
  commands: 'scope.commands',
  sessions: 'scope.sessions',
  settings: 'scope.settings',
  help: 'page.help',
}

function placeholderFor(page: PageId, facts: MenuFacts, t: Translate): string {
  switch (page) {
    case 'root': return t('placeholder.root')
    case 'models': return t('placeholder.models')
    case 'themes': return t('placeholder.themes')
    case 'workspaces': return t('placeholder.workspaces')
    case 'help': return t('placeholder.help')
    default: return t('placeholder.workspace', { name: pageLabel(page, facts, t) ?? '' })
  }
}

/**
 * The menu, portaled to `document.body` while open.
 * @param props - see {@link CommandMenuProps}.
 * @returns the dialog, or null while closed.
 */
export function CommandMenu(props: CommandMenuProps) {
  if (!props.open) return null
  return createPortal(<MenuSurface {...props} />, document.body)
}

function MenuSurface(props: CommandMenuProps) {
  const { facts, settings, recents, t, onRun, onPage, onClose, searchMessages } = props
  const [pages, setPages] = useState<readonly PageId[]>(() => props.initialPage === undefined || props.initialPage === 'root' ? ['root'] : ['root', props.initialPage])
  const page = pages[pages.length - 1] ?? 'root'
  const [query, setQuery] = useState('')
  const parsed = parseQuery(query, page)
  const [messages, setMessages] = useState<MessageState>(IDLE)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const pointerMoved = useRef(false)
  const baseId = useId()
  const listId = `${baseId}-list`
  const sheet = useSheet()

  // Return focus to whatever held it before the menu opened.
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      if (previous !== null && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const searchText = page === 'root' && (parsed.scope === 'all' || parsed.scope === 'sessions') ? parsed.text : ''
  useEffect(() => {
    if (searchMessages === undefined || !settings.messageSearch || searchText.length < MESSAGE_SEARCH_MIN) {
      setMessages(IDLE)
      return
    }
    const controller = new AbortController()
    setMessages({ status: 'loading', text: searchText })
    const timer = setTimeout(() => {
      searchMessages(searchText, controller.signal).then((hits) => {
        if (!controller.signal.aborted) setMessages({ status: 'ready', text: searchText, hits })
      }, (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof Error && error.name === SEARCH_OFF) setMessages({ status: 'off', text: searchText })
        else setMessages({ status: 'error', text: searchText, message: error instanceof Error ? error.message : String(error) })
      })
    }, MESSAGE_SEARCH_DELAY)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [searchMessages, settings.messageSearch, searchText])

  const entries = useMemo(() => {
    const base = buildEntries(facts, page, t, {})
    if (page !== 'root' || messages.status !== 'ready' || messages.text !== searchText) return base
    return [...base, ...messageEntries(messages.hits, facts, messages.text)]
  }, [facts, page, t, messages, searchText])

  const sections = useMemo(() => buildSections({
    entries,
    query: parsed,
    recents,
    recentLimit: settings.recentLimit,
    groupLimit: settings.groupLimit,
    showAll: page !== 'root',
  }), [entries, parsed.scope, parsed.text, recents, settings.recentLimit, settings.groupLimit, page])
  const rows = useMemo(() => flatten(sections), [sections])
  const activeIndex = Math.max(0, rows.findIndex(entry => entry.id === activeId))
  const active = rows[activeIndex]
  const activeDomId = active === undefined ? undefined : `${baseId}-opt-${activeIndex}`

  // Browsers do not scroll an aria-activedescendant target into view on their own.
  useEffect(() => {
    if (activeDomId === undefined) return
    const node = document.getElementById(activeDomId)
    if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [activeDomId])

  // A new query or page starts at the first row.
  useEffect(() => { setActiveId(undefined) }, [query, page])


  const pushPage = useCallback((next: PageId) => {
    setPages(stack => [...stack, next])
    setQuery('')
    onPage?.(next)
  }, [onPage])

  const back = useCallback((): boolean => {
    if (pages.length <= 1) return false
    setPages(stack => stack.slice(0, -1))
    setQuery('')
    return true
  }, [pages.length])

  const choose = useCallback((entry: MenuEntry | undefined) => {
    if (entry === undefined) return
    if (entry.page !== undefined) {
      pushPage(entry.page)
      return
    }
    if (entry.kind === 'scope') {
      setPages(['root'])
      setQuery(`${entry.ref ?? ''}`)
      inputRef.current?.focus()
      return
    }
    onRun(entry, parsed.text)
  }, [onRun, parsed.text, pushPage])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    const nav = (key: Parameters<typeof moveActive>[0]): void => {
      event.preventDefault()
      const next = moveActive(key, active === undefined ? -1 : activeIndex, rows.length)
      setActiveId(rows[next]?.id)
    }
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey
    switch (event.key) {
      case 'ArrowDown': nav('ArrowDown'); return
      case 'ArrowUp': nav('ArrowUp'); return
      case 'PageDown': nav('PageDown'); return
      case 'PageUp': nav('PageUp'); return
      case 'Home': if (event.ctrlKey || event.metaKey) nav('Home'); return
      case 'End': if (event.ctrlKey || event.metaKey) nav('End'); return
      case 'n': if (ctrlOnly) nav('ArrowDown'); return
      case 'p': if (ctrlOnly) nav('ArrowUp'); return
      case 'Enter':
        event.preventDefault()
        if (!event.repeat) choose(active)
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        if (!back()) onClose()
        return
      case 'Backspace':
        if (query === '' && back()) event.preventDefault()
        return
      case 'Tab':
        // The field is the dialog's only stop; Tab stays inside.
        event.preventDefault()
        return
      default:
    }
  }

  const terms = parsed.text.toLowerCase().split(/\s+/).filter(term => term !== '')
  const crumb = pageLabel(page, facts, t)
  const status = page === 'root' ? messageStatus(messages, searchText, t) : page === 'models' ? modelStatus(facts, t) : undefined
  const noSession = page === 'root' && parsed.scope === 'commands' && facts.currentSessionId === undefined

  return (
    <div className={CLASS.root} data-command-menu="" data-sheet={sheet ? '' : undefined}>
      <div className={CLASS.scrim} aria-hidden="true" onPointerDown={(event) => { event.preventDefault(); onClose() }} />
      <div
        className={CLASS.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        data-sheet={sheet ? '' : undefined}
        onPointerMove={() => { pointerMoved.current = true }}
      >
        <div className={CLASS.header}>
          {crumb !== undefined && (
            <button type="button" tabIndex={-1} className={CLASS.back} aria-label={t('aria.back')} onClick={() => { back(); inputRef.current?.focus() }}>
              <IconChevronLeftOutlineRegular size={14} />
              <span className={CLASS.crumb}>{crumb}</span>
            </button>
          )}
          {crumb === undefined && parsed.scope !== 'all' && (
            <span className={CLASS.scope} data-scope={parsed.scope}>{t(SCOPE_BADGE[parsed.scope])}</span>
          )}
          <label className={CLASS.field}>
            <span className={CLASS.fieldIcon} aria-hidden="true"><IconSearchOutlineRegular size={16} /></span>
            <input
              ref={inputRef}
              className={CLASS.input}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeDomId}
              aria-label={placeholderFor(page, facts, t)}
              placeholder={placeholderFor(page, facts, t)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={onKeyDown}
            />
          </label>
          {sheet && (
            <button type="button" tabIndex={-1} className={CLASS.close} aria-label={t('aria.close')} onClick={onClose}>
              <IconCloseOutlineRegular size={16} />
            </button>
          )}
        </div>
        <div ref={listRef} id={listId} className={CLASS.list} role="listbox" aria-label={t('aria.menu')}>
          {sections.map((section) => {
            const headingId = `${baseId}-group-${section.group}`
            return (
              <div key={section.group} className={CLASS.group} role="group" aria-labelledby={headingId}>
                <div id={headingId} className={CLASS.groupTitle} role="presentation">{t(GROUP_LABEL[section.group])}</div>
                {section.entries.map((entry) => {
                  const index = rows.indexOf(entry)
                  const isActive = entry === active
                  return (
                    <div
                      key={entry.id}
                      id={`${baseId}-opt-${index}`}
                      className={CLASS.option}
                      role="option"
                      aria-selected={isActive}
                      aria-current={entry.current === true ? 'true' : undefined}
                      data-entry-id={entry.id}
                      data-kind={entry.kind}
                      data-active={isActive ? '' : undefined}
                      onPointerMove={() => { if (pointerMoved.current && !isActive) setActiveId(entry.id) }}
                      onPointerDown={(event) => { event.preventDefault() }}
                      onClick={() => { choose(entry) }}
                    >
                      <span className={CLASS.optionIcon} aria-hidden="true"><MenuIcon name={entry.icon} /></span>
                      <span className={CLASS.optionMain}>
                        <span className={CLASS.optionTitle}>{highlight(entry.title, terms)}</span>
                        {entry.detail !== undefined && entry.detail !== '' && (
                          <span className={CLASS.optionDetail}>{entry.kind === 'message' ? highlight(entry.detail, terms) : entry.detail}</span>
                        )}
                      </span>
                      {entry.hint !== undefined && <span className={CLASS.optionHint}>{entry.hint}</span>}
                      {entry.shortcut !== undefined && (
                        <span className={CLASS.keys} aria-hidden="true">{entry.shortcut.map(key => <kbd key={key} className={CLASS.kbd}>{key}</kbd>)}</span>
                      )}
                      {entry.page !== undefined && <span className={CLASS.chevron} aria-hidden="true"><IconChevronRightOutlineRegular size={14} /></span>}
                    </div>
                  )
                })}
                {section.more !== undefined && <div className={CLASS.more} role="presentation">{t('status.more', { count: section.more })}</div>}
              </div>
            )
          })}
          {rows.length === 0 && status === undefined && (
            <div className={CLASS.empty} role="presentation">
              {noSession ? t('status.noSession') : parsed.text === '' ? t('empty.blank') : t('empty', { query: parsed.text })}
            </div>
          )}
          {status !== undefined && <div className={CLASS.status} role="presentation" data-status={status.kind}>{status.text}</div>}
        </div>
        <div className={CLASS.srOnly} role="status" aria-live="polite">{t('aria.results', { count: rows.length })}</div>
        {!sheet && (
          <div className={CLASS.footer} aria-hidden="true">
            <span><kbd className={CLASS.kbd}>↑</kbd><kbd className={CLASS.kbd}>↓</kbd>{t('footer.navigate')}</span>
            <span><kbd className={CLASS.kbd}>↵</kbd>{t('footer.open')}</span>
            {pages.length > 1 && <span><kbd className={CLASS.kbd}>⌫</kbd>{t('footer.back')}</span>}
            <span><kbd className={CLASS.kbd}>esc</kbd>{t('footer.close')}</span>
            <span className={CLASS.keys}>{props.hotkeyKeys.map(key => <kbd key={key} className={CLASS.kbd}>{key}</kbd>)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function messageStatus(messages: MessageState, text: string, t: Translate): { kind: string; text: string } | undefined {
  if (messages.status === 'loading' && messages.text === text) return { kind: 'loading', text: t('status.searching') }
  if (messages.status === 'error' && messages.text === text) return { kind: 'error', text: t('status.searchFailed', { reason: messages.message }) }
  if (messages.status === 'off' && messages.text === text) return { kind: 'off', text: t('status.searchOff') }
  return undefined
}

function modelStatus(facts: MenuFacts, t: Translate): { kind: string; text: string } | undefined {
  if (facts.models.status === 'loading') return { kind: 'loading', text: t('status.modelsLoading') }
  if (facts.models.status === 'error') return { kind: 'error', text: t('status.modelsFailed', { reason: facts.models.message }) }
  if (facts.models.status === 'unavailable') return { kind: 'error', text: t('status.noSession') }
  return undefined
}
