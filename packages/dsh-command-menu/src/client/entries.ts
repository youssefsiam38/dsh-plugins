/**
 * Build menu entries from a plain snapshot of what the Web client knows
 * (sessions, workspaces, commands, settings pages, themes, models). Pure:
 * the browser plugin gathers the facts, tests pass them directly.
 * @module dsh-command-menu/client/entries
 */

import type { CommandMenuKey } from './locales.ts'
import type { MenuEntry, PageId } from './model.ts'

/** Translator for this plugin's namespace. */
export type Translate = (key: CommandMenuKey, params?: Record<string, string | number>) => string

/** One session row. */
export interface SessionFact {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly current: boolean
  readonly workspaceId?: string
  readonly workspaceTitle?: string
}

/** One workspace row. */
export interface WorkspaceFact {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionCount: number
}

/** One slash command of the current session. */
export interface CommandFact {
  readonly name: string
  readonly description: string
  /** Free-form input hint; set when the command takes arguments. */
  readonly inputHint?: string
}

/** One settings page. */
export interface SettingsFact {
  readonly id: string
  readonly label: string
}

/** One model of the current session's directory. */
export interface ModelFact {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly current: boolean
}

/** Async list state. */
export type Loadable<T> =
  | { readonly status: 'unavailable' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly items: readonly T[] }

/** One theme option. */
export interface ThemeFact {
  readonly id: string
  readonly colorScheme?: 'light' | 'dark'
}

/** Which app actions the loaded plugins support. */
export interface Capabilities {
  readonly newSession: boolean
  readonly sidebar: boolean
  readonly rightbar: boolean
  readonly settings: boolean
  readonly fork: boolean
  readonly stop: boolean
  readonly focusComposer: boolean
}

/** Everything the menu lists, as plain data. */
export interface MenuFacts {
  readonly sessions: readonly SessionFact[]
  readonly workspaces: readonly WorkspaceFact[]
  readonly commands: Loadable<CommandFact>
  readonly models: Loadable<ModelFact>
  readonly settings: readonly SettingsFact[]
  /** Undefined without the theme service. */
  readonly themes?: { readonly preference: string; readonly active: 'light' | 'dark'; readonly options: readonly ThemeFact[] }
  readonly capabilities: Capabilities
  /** The session shown in the main view, if any. */
  readonly currentSessionId?: string
  /** Wall clock (ms) for relative times. */
  readonly now: number
}

/** A full-text hit from the Host session search. */
export interface MessageHit {
  readonly sessionId: string
  readonly snippet: string
}

/** Error name a message search rejects with when the Host has content search turned off. */
export const SEARCH_OFF = 'MessageSearchOff'

/** Facts with nothing loaded. */
export const EMPTY_FACTS: MenuFacts = {
  sessions: [],
  workspaces: [],
  commands: { status: 'unavailable' },
  models: { status: 'unavailable' },
  settings: [],
  capabilities: {
    newSession: false, sidebar: false, rightbar: false, settings: false, fork: false, stop: false, focusComposer: false,
  },
  now: 0,
}

/**
 * Localized compact age of a timestamp.
 * @param at - epoch ms.
 * @param now - epoch ms.
 * @param t - translator.
 * @returns e.g. `5m`, `3h`, `2d`.
 */
export function relativeAge(at: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return t('time.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.days', { n: days })
  if (days < 365) return t('time.months', { n: Math.floor(days / 30) })
  return t('time.years', { n: Math.floor(days / 365) })
}

/**
 * Label of a theme id.
 * @param id - theme id or `system`.
 * @param t - translator.
 * @returns localized label for the built-in ids, the id otherwise.
 */
export function themeLabel(id: string, t: Translate): string {
  if (id === 'system') return t('theme.system')
  if (id === 'light') return t('theme.light')
  if (id === 'dark') return t('theme.dark')
  return id
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(word => word !== '')
}

function sessionEntry(session: SessionFact, order: number, facts: MenuFacts, t: Translate): MenuEntry {
  return {
    id: `session:${session.id}`,
    kind: 'session',
    ref: session.id,
    group: 'sessions',
    title: session.title,
    ...session.workspaceTitle !== undefined ? { detail: session.workspaceTitle } : session.cwd !== undefined ? { detail: session.cwd } : {},
    keywords: [session.id],
    icon: 'chat',
    hint: session.current ? t('hint.current') : session.running ? t('hint.running') : relativeAge(session.updatedAt, facts.now, t),
    ...session.current ? { current: true } : {},
    ...session.running ? { boost: 1 } : {},
    order,
  }
}

function sortedSessions(sessions: readonly SessionFact[]): SessionFact[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

function rootEntries(facts: MenuFacts, t: Translate, shortcuts: Readonly<Record<string, readonly string[]>>): MenuEntry[] {
  const entries: MenuEntry[] = []
  let order = 0
  const action = (id: string, title: string, icon: MenuEntry['icon'], keywords: string, extra: Partial<MenuEntry> = {}): void => {
    entries.push({
      id: `action:${id}`, kind: 'action', ref: id, group: 'actions', title, icon, keywords: words(keywords), order: order++,
      ...shortcuts[id] === undefined ? {} : { shortcut: shortcuts[id] },
      ...extra,
    })
  }
  const caps = facts.capabilities
  const current = facts.currentSessionId !== undefined
  if (caps.newSession) action('new-session', t('action.newSession'), 'new', t('keywords.newSession'))
  if (facts.models.status !== 'unavailable') {
    action('models', t('action.switchModel'), 'model', t('keywords.model'), { page: 'models', hint: t('hint.opensPage') })
  }
  if (facts.workspaces.length > 0) {
    action('workspaces', t('action.browseWorkspaces'), 'folder', '', { page: 'workspaces', hint: t('hint.opensPage') })
  }
  if (facts.themes !== undefined) {
    const options = new Set(facts.themes.options.map(option => option.id))
    if (options.has('light') && options.has('dark')) action('toggle-theme', t('action.toggleTheme'), facts.themes.active === 'dark' ? 'light' : 'dark', t('keywords.theme'))
    action('themes', t('action.changeTheme'), 'theme', t('keywords.theme'), { page: 'themes', hint: t('hint.opensPage') })
  }
  if (caps.sidebar) action('toggle-sidebar', t('action.toggleSidebar'), 'sidebar', t('keywords.sidebar'))
  if (caps.rightbar) action('toggle-rightbar', t('action.toggleRightbar'), 'panel', t('keywords.sidebar'))
  if (caps.settings) action('open-settings', t('action.openSettings'), 'settings', t('keywords.settings'))
  if (current && caps.stop) action('stop', t('action.stopTurn'), 'stop', t('keywords.stop'))
  if (current && caps.fork) action('fork', t('action.forkSession'), 'branch', t('keywords.fork'))
  if (current && caps.focusComposer) action('focus-composer', t('action.focusComposer'), 'compose', '')
  action('scopes', t('action.scopes'), 'help', '? > / @ #', { page: 'help', hint: '?' })

  sortedSessions(facts.sessions).forEach((session, index) => { entries.push(sessionEntry(session, index, facts, t)) })

  if (facts.commands.status === 'ready') {
    facts.commands.items.forEach((command, index) => {
      entries.push({
        id: `command:${command.name}`,
        kind: 'command',
        ref: command.name,
        group: 'commands',
        title: `/${command.name}`,
        detail: command.inputHint === undefined ? command.description : `${command.description} · ${t('command.needsInput', { hint: command.inputHint })}`,
        keywords: [command.name, ...words(command.description)],
        icon: 'command',
        order: index,
      })
    })
  }
  facts.workspaces.forEach((workspace, index) => {
    entries.push(workspaceEntry(workspace, index, t))
  })
  facts.settings.forEach((section, index) => {
    entries.push({
      id: `settings:${section.id}`, kind: 'settings', ref: section.label, group: 'settings', title: section.label,
      keywords: [section.id, ...words(t('keywords.settings'))], icon: 'settings', order: index,
    })
  })
  entries.push(...modelEntries(facts), ...themeEntries(facts, t))
  return entries
}

function workspaceEntry(workspace: WorkspaceFact, order: number, t: Translate): MenuEntry {
  return {
    id: `workspace:${workspace.id}`,
    kind: 'workspace',
    ref: workspace.id,
    group: 'workspaces',
    title: workspace.title,
    detail: workspace.path,
    keywords: words(workspace.path.replace(/[\\/]/g, ' ')),
    icon: 'folder',
    hint: t('workspace.sessions', { count: workspace.sessionCount }),
    page: `workspace:${workspace.id}`,
    order,
  }
}

function modelEntries(facts: MenuFacts): MenuEntry[] {
  if (facts.models.status !== 'ready') return []
  return facts.models.items.map((model, index) => ({
    id: `model:${model.provider}/${model.id}`,
    kind: 'model',
    ref: `${model.provider}\u0000${model.id}`,
    group: 'models',
    title: model.name,
    detail: `${model.providerName} · ${model.id}`,
    keywords: [model.id, model.provider, ...words(model.providerName)],
    icon: 'model',
    ...model.current ? { current: true, hint: '✓' } : {},
    order: index,
  }))
}

function themeEntries(facts: MenuFacts, t: Translate): MenuEntry[] {
  if (facts.themes === undefined) return []
  const preference = facts.themes.preference
  const ids = ['system', ...facts.themes.options.map(option => option.id).filter(id => id !== 'system')]
  return ids.map((id, index) => ({
    id: `theme:${id}`,
    kind: 'theme',
    ref: id,
    group: 'themes',
    title: themeLabel(id, t),
    keywords: [id, ...words(t('keywords.theme'))],
    icon: id === 'system' ? 'system' : facts.themes?.options.find(option => option.id === id)?.colorScheme === 'dark' ? 'dark' : 'light',
    ...id === preference ? { current: true, hint: '✓' } : {},
    order: index,
  }))
}

function helpEntries(t: Translate): MenuEntry[] {
  const scope = (prefix: string, title: string, detail: string, order: number): MenuEntry => ({
    id: `scope:${prefix}`, kind: 'scope', ref: prefix, group: 'scopes', title, detail, icon: 'search', hint: prefix, order,
  })
  return [
    scope('>', t('scope.commands'), t('scope.commandsDetail'), 0),
    scope('@', t('scope.sessions'), t('scope.sessionsDetail'), 1),
    scope('#', t('scope.settings'), t('scope.settingsDetail'), 2),
  ]
}

/**
 * Entries of one page.
 * @param facts - current facts.
 * @param page - the page on display.
 * @param t - translator.
 * @param shortcuts - keycaps by action id, shown on action rows.
 * @returns the page's entries (message hits are added separately).
 */
export function buildEntries(
  facts: MenuFacts,
  page: PageId,
  t: Translate,
  shortcuts: Readonly<Record<string, readonly string[]>> = {},
): MenuEntry[] {
  if (page === 'root') return [...rootEntries(facts, t, shortcuts), ...helpEntries(t)]
  if (page === 'models') return modelEntries(facts)
  if (page === 'themes') return themeEntries(facts, t)
  if (page === 'help') return helpEntries(t)
  if (page === 'workspaces') return facts.workspaces.map((workspace, index) => workspaceEntry(workspace, index, t))
  const workspaceId = page.slice('workspace:'.length)
  const workspace = facts.workspaces.find(candidate => candidate.id === workspaceId)
  const entries: MenuEntry[] = []
  if (workspace !== undefined && facts.capabilities.newSession) {
    entries.push({
      id: `action:new-session-in:${workspace.id}`, kind: 'action', ref: `new-session-in:${workspace.id}`, group: 'actions',
      title: t('workspace.newSession', { name: workspace.title }), icon: 'new', keywords: words(t('keywords.newSession')), order: 0,
    })
  }
  sortedSessions(facts.sessions.filter(session => session.workspaceId === workspaceId))
    .forEach((session, index) => { entries.push(sessionEntry(session, index, facts, t)) })
  return entries
}

/**
 * Entries for full-text hits: the first hit per session, skipping sessions
 * without a listed row (archived, blank, or subagent sessions).
 * @param hits - Host search results.
 * @param facts - current facts (session titles).
 * @param query - the searched text, kept on the entry for revealing the match.
 * @returns one `messages` entry per hit.
 */
export function messageEntries(hits: readonly MessageHit[], facts: MenuFacts, query: string): MenuEntry[] {
  const titles = new Map(facts.sessions.map(session => [session.id, session.title]))
  const seen = new Set<string>()
  return hits.flatMap((hit, index) => {
    const title = titles.get(hit.sessionId)
    if (title === undefined || seen.has(hit.sessionId)) return []
    seen.add(hit.sessionId)
    return [{
      id: `message:${hit.sessionId}`,
      kind: 'message' as const,
      ref: hit.sessionId,
      group: 'messages' as const,
      title,
      detail: hit.snippet.replace(/\s+/g, ' ').trim(),
      keywords: [query],
      icon: 'search' as const,
      order: index,
    }]
  })
}

/**
 * Split a page id into its breadcrumb label.
 * @param page - page id.
 * @param facts - current facts (workspace titles).
 * @param t - translator.
 * @returns the label, or undefined for the root page.
 */
export function pageLabel(page: PageId, facts: MenuFacts, t: Translate): string | undefined {
  switch (page) {
    case 'root': return undefined
    case 'models': return t('page.models')
    case 'themes': return t('page.themes')
    case 'workspaces': return t('page.workspaces')
    case 'help': return t('page.help')
    default: return facts.workspaces.find(workspace => `workspace:${workspace.id}` === page)?.title ?? page
  }
}
