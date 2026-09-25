/**
 * Pure menu data: the entry type, scope prefixes, ranking, and the grouped
 * sections the list renders. Nothing here reads a service or the DOM.
 * @module dsh-command-menu/client/model
 */

import { matchSorterWithRankInfo } from 'match-sorter'
import type { KeyOption } from 'match-sorter'

/** What one entry is; decides its icon and what running it does. */
export type EntryKind =
  | 'action' | 'session' | 'message' | 'command' | 'settings' | 'workspace' | 'model' | 'theme' | 'scope'

/** Rendered group, in the default (empty-query) order. */
export type GroupId =
  | 'recent' | 'actions' | 'sessions' | 'messages' | 'commands' | 'workspaces' | 'models' | 'settings' | 'themes' | 'scopes'

/** Group order with a blank query. */
export const GROUP_ORDER: readonly GroupId[] = [
  'recent', 'actions', 'sessions', 'commands', 'workspaces', 'models', 'settings', 'themes', 'messages', 'scopes',
]

/** Nested page shown in the menu. `root` is the top level. */
export type PageId = 'root' | 'models' | 'themes' | 'workspaces' | 'help' | `workspace:${string}`

/** Icon names the view maps to glyphs. */
export type IconName =
  | 'chat' | 'search' | 'new' | 'sidebar' | 'panel' | 'settings' | 'folder' | 'model' | 'theme' | 'light' | 'dark'
  | 'system' | 'command' | 'branch' | 'stop' | 'compose' | 'help' | 'check'

/** One selectable row. */
export interface MenuEntry {
  /** Stable id (`kind:key`); recents are keyed by it. */
  readonly id: string
  readonly kind: EntryKind
  /** What running the entry targets: a session id, command name, section label, theme id, or model key. */
  readonly ref?: string
  readonly group: GroupId
  readonly title: string
  /** Secondary text: a path, a snippet, a description. */
  readonly detail?: string
  /** Extra words that match but are not shown. */
  readonly keywords?: readonly string[]
  readonly icon: IconName
  /** Trailing label: a time, `/name`, `current`. */
  readonly hint?: string
  /** Keycaps shown at the row end. */
  readonly shortcut?: readonly string[]
  /** The page this row opens instead of running. */
  readonly page?: PageId
  /** Marks the current model, theme, or session. */
  readonly current?: boolean
  /** Ranking bonus for otherwise equal matches (for example a running session). */
  readonly boost?: number
  /** Position in its source list, the final tie-breaker. */
  readonly order: number
}

/** A rendered section. */
export interface Section {
  readonly group: GroupId
  readonly entries: readonly MenuEntry[]
  /** Set when the group has more matches than it shows. */
  readonly more?: number
}

/** Narrowing a `>`, `/`, `@`, `#`, or `?` prefix applies on the root page. */
export type Scope = 'all' | 'commands' | 'sessions' | 'settings' | 'help'

/** Prefix characters and the scope each selects. */
export const PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly scope: Exclude<Scope, 'all'> }> = [
  { prefix: '>', scope: 'commands' },
  { prefix: '/', scope: 'commands' },
  { prefix: '@', scope: 'sessions' },
  { prefix: '#', scope: 'settings' },
  { prefix: '?', scope: 'help' },
]

/** Groups each scope keeps, in their blank-query order. */
const SCOPE_GROUPS: Record<Scope, readonly GroupId[] | undefined> = {
  all: undefined,
  commands: ['commands', 'actions'],
  sessions: ['sessions', 'workspaces', 'messages'],
  settings: ['settings', 'themes'],
  help: ['scopes'],
}

/** A parsed query. */
export interface ParsedQuery {
  readonly scope: Scope
  /** The query text after the prefix, trimmed. */
  readonly text: string
}

/**
 * Split a typed query into its scope prefix and text. Prefixes apply only on
 * the root page; nested pages search their own rows.
 * @param raw - the input value.
 * @param page - the page on display.
 * @returns the scope and the remaining text.
 */
export function parseQuery(raw: string, page: PageId): ParsedQuery {
  const trimmed = raw.trimStart()
  if (page === 'root') {
    const hit = PREFIXES.find(entry => trimmed.startsWith(entry.prefix))
    if (hit !== undefined) return { scope: hit.scope, text: trimmed.slice(hit.prefix.length).trim() }
  }
  return { scope: 'all', text: trimmed.trim() }
}

/**
 * Whether an entry's group belongs to a scope.
 * @param scope - active scope.
 * @param group - entry group.
 * @returns true when shown.
 */
export function inScope(scope: Scope, group: GroupId): boolean {
  const groups = SCOPE_GROUPS[scope]
  return groups === undefined || groups.includes(group)
}

const KEYS: ReadonlyArray<KeyOption<MenuEntry>> = [
  'title',
  // A keyword hit never outranks a title that starts with the query.
  { key: entry => [...entry.keywords ?? []], maxRanking: 4 },
  { key: 'detail', maxRanking: 3 },
]

/**
 * Rank entries against a query: every whitespace-separated term must match
 * (title, keywords, then detail); a better rank per term, then a recent use,
 * then the entry's boost, then source order win.
 * @param entries - candidate entries.
 * @param text - query text without the prefix.
 * @param recents - recently used entry ids, newest first.
 * @returns matching entries, best first, with their scores.
 */
export function rankEntries(
  entries: readonly MenuEntry[],
  text: string,
  recents: readonly string[] = [],
): Array<{ entry: MenuEntry; score: number }> {
  const terms = text.toLowerCase().split(/\s+/).filter(term => term !== '')
  const recency = new Map(recents.map((id, index) => [id, index]))
  const score = new Map<MenuEntry, number>()
  let pool: readonly MenuEntry[] = entries
  for (const term of terms) {
    const ranked = matchSorterWithRankInfo(pool, term, { keys: KEYS })
    const next: MenuEntry[] = []
    for (const hit of ranked) {
      score.set(hit.item, (score.get(hit.item) ?? 0) + hit.rank * 8 - Math.min(hit.keyIndex, 3))
      next.push(hit.item)
    }
    pool = next
  }
  const total = (entry: MenuEntry): number => {
    const recent = recency.get(entry.id)
    // Smaller than one rank step (8), so recency only reorders equally good matches.
    const recentBonus = recent === undefined ? 0 : Math.max(0, 6 - recent)
    return (score.get(entry) ?? 0) + recentBonus + (entry.boost ?? 0)
  }
  return pool
    .map(entry => ({ entry, score: total(entry) }))
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
}

/** Inputs of {@link buildSections}. */
export interface SectionInput {
  readonly entries: readonly MenuEntry[]
  readonly query: ParsedQuery
  /** Recently used entry ids, newest first. */
  readonly recents: readonly string[]
  /** Recents listed with a blank query; 0 turns the section off. */
  readonly recentLimit: number
  /** Most rows one group shows. */
  readonly groupLimit: number
  /** Groups that list every row with a blank query (nested pages). */
  readonly showAll: boolean
}

/** Groups that stay hidden until a query is typed on the root page. */
const QUERY_ONLY: ReadonlySet<GroupId> = new Set(['commands', 'models', 'settings', 'themes', 'messages', 'workspaces'])

/**
 * Build the rendered sections.
 *
 * Blank query on the root page: Recent (up to `recentLimit`), Actions, the
 * latest sessions, and the scope-narrowed groups when a prefix is typed.
 * Typed query: one section per group, groups ordered by their best hit,
 * rows by rank, each capped at `groupLimit`; message hits keep the Host's
 * order in a final section.
 * @param input - entries, query, and limits.
 * @returns the sections, empty groups dropped.
 */
export function buildSections(input: SectionInput): Section[] {
  const { query, recents, groupLimit } = input
  const visible = input.entries.filter(entry => inScope(query.scope, entry.group))
  if (query.text === '') {
    const byId = new Map(visible.map(entry => [entry.id, entry]))
    const sections: Section[] = []
    const recentEntries = query.scope === 'all' && !input.showAll
      ? recents.flatMap((id) => {
        const entry = byId.get(id)
        return entry === undefined || entry.kind === 'message' ? [] : [entry]
      }).slice(0, input.recentLimit)
      : []
    const shownRecent = new Set(recentEntries.map(entry => entry.id))
    if (recentEntries.length > 0) sections.push({ group: 'recent', entries: recentEntries })
    for (const group of SCOPE_GROUPS[query.scope] ?? GROUP_ORDER) {
      if (group === 'recent') continue
      if (!input.showAll && query.scope === 'all' && QUERY_ONLY.has(group)) continue
      const rows = visible
        .filter(entry => entry.group === group && !shownRecent.has(entry.id))
        .sort((a, b) => a.order - b.order)
      if (rows.length === 0) continue
      const limit = input.showAll ? rows.length : groupLimit
      sections.push({ group, entries: rows.slice(0, limit), ...rows.length > limit ? { more: rows.length - limit } : {} })
    }
    return sections
  }
  // Message hits are already matched and ordered by the Host; they follow the ranked groups.
  const messages = visible.filter(entry => entry.kind === 'message')
  const ranked = rankEntries(visible.filter(entry => entry.kind !== 'message'), query.text, recents)
  const groups = new Map<GroupId, Array<{ entry: MenuEntry; score: number }>>()
  for (const hit of ranked) {
    const list = groups.get(hit.entry.group) ?? []
    list.push(hit)
    groups.set(hit.entry.group, list)
  }
  const sections: Section[] = [...groups.entries()]
    .sort(([groupA, a], [groupB, b]) =>
      (b[0]?.score ?? 0) - (a[0]?.score ?? 0) || GROUP_ORDER.indexOf(groupA) - GROUP_ORDER.indexOf(groupB))
    .map(([group, hits]) => ({
      group,
      entries: hits.slice(0, groupLimit).map(hit => hit.entry),
      ...hits.length > groupLimit ? { more: hits.length - groupLimit } : {},
    }))
  if (messages.length > 0) {
    sections.push({
      group: 'messages',
      entries: messages.slice(0, groupLimit),
      ...messages.length > groupLimit ? { more: messages.length - groupLimit } : {},
    })
  }
  return sections
}

/**
 * Flatten sections into the navigable row order.
 * @param sections - rendered sections.
 * @returns entries in display order.
 */
export function flatten(sections: readonly Section[]): MenuEntry[] {
  return sections.flatMap(section => section.entries)
}

/**
 * The next active index for a navigation key, wrapping at both ends.
 * @param key - the navigation key.
 * @param index - the current active index (-1 for none).
 * @param count - number of rows.
 * @param page - rows one PageUp/PageDown moves.
 * @returns the new index, or -1 when there are no rows.
 */
export function moveActive(
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp',
  index: number,
  count: number,
  page = 8,
): number {
  if (count === 0) return -1
  switch (key) {
    case 'ArrowDown': return index < 0 ? 0 : (index + 1) % count
    case 'ArrowUp': return index <= 0 ? count - 1 : index - 1
    case 'Home': return 0
    case 'End': return count - 1
    case 'PageDown': return Math.min(count - 1, Math.max(0, index) + page)
    case 'PageUp': return Math.max(0, index - page)
  }
}
