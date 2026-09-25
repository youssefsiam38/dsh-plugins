/**
 * Pure picker data: provider and model entries built from the shared model
 * directory, fuzzy ranking, and the sections the list renders (Favorites,
 * Recent, then one group per provider).
 * @module dsh-model-switcher/client/search
 */

import { matchSorter, matchSorterWithRankInfo, rankings } from 'match-sorter'
import type { KeyOption } from 'match-sorter'
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelReasoning, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'

/** Key status of one provider, as far as the Host reports it. */
export type ProviderStatus = 'signed-in' | 'ready' | 'needs-key' | 'error' | 'unknown'

/** Metadata the Host discloses about one model beyond the catalog row. */
export interface ModelMeta {
  /** Maximum combined request and response context, in tokens. */
  readonly contextWindow?: number
  /** Maximum output tokens. */
  readonly maxTokens?: number
  /** Whether the model accepts image input; undefined when not disclosed. */
  readonly vision?: boolean
}

/** One selectable model row. */
export interface ModelEntry {
  /** Opaque row key: provider and model id joined by a NUL character. */
  readonly key: string
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: ModelReasoning
  readonly meta?: ModelMeta
  /** Position in the directory, the final tie-breaker. */
  readonly order: number
}

/** One provider option of the provider select. */
export interface ProviderEntry {
  readonly id: string
  readonly name: string
  /** Models the provider lists in the directory. */
  readonly count: number
  readonly status: ProviderStatus
  /** Catalog failure text for `error` providers. */
  readonly message?: string
}

/** One rendered list section. */
export interface Section {
  /** Stable id used for DOM ids. */
  readonly id: string
  readonly kind: 'favorites' | 'recents' | 'provider'
  /** Provider id of a `provider` section. */
  readonly provider?: string
  readonly entries: readonly ModelEntry[]
}

/**
 * Row key of a provider/model pair.
 * @param provider - provider route id.
 * @param model - provider-owned model id.
 * @returns the opaque key.
 */
export function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Split a row key back into its selection (keys are built only by {@link modelKey}).
 * @param key - a row key.
 * @returns the provider/model selection.
 */
export function selectionOfKey(key: string): ModelSelection {
  const at = key.indexOf('\u0000')
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/**
 * Flatten directory groups into model entries.
 * @param groups - loaded provider groups.
 * @param meta - disclosed metadata by row key.
 * @returns entries in directory order.
 */
export function modelEntries(
  groups: readonly ModelProviderGroup[],
  meta: ReadonlyMap<string, ModelMeta>,
): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const group of groups) {
    for (const model of group.models) {
      const key = modelKey(group.id, model.id)
      const known = meta.get(key)
      entries.push({
        key,
        provider: group.id,
        providerName: group.name,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
        ...known === undefined ? {} : { meta: known },
        order: entries.length,
      })
    }
  }
  return entries
}

/**
 * Build the provider options: loaded groups first, then failed catalogs.
 * @param groups - loaded provider groups.
 * @param failures - providers whose catalog failed to load.
 * @param status - Host-reported key status by provider id.
 * @returns provider options in directory order.
 */
export function providerEntries(
  groups: readonly ModelProviderGroup[],
  failures: readonly ModelCatalogFailure[],
  status: ReadonlyMap<string, ProviderStatus>,
): ProviderEntry[] {
  const providers: ProviderEntry[] = groups.map(group => ({
    id: group.id,
    name: group.name,
    count: group.models.length,
    status: status.get(group.id) ?? 'unknown',
  }))
  const listed = new Set(providers.map(provider => provider.id))
  for (const failure of failures) {
    if (listed.has(failure.id)) continue
    providers.push({ id: failure.id, name: failure.name, count: 0, status: 'error', message: failure.message })
  }
  return providers
}

/**
 * Filter provider options by a query over their names and ids.
 * @param providers - provider options in directory order.
 * @param query - the provider search text.
 * @returns matching options, best match first; all of them for a blank query.
 */
export function filterProviders(providers: readonly ProviderEntry[], query: string): readonly ProviderEntry[] {
  const text = query.trim()
  if (text === '') return providers
  return matchSorter(providers, text, { keys: ['name', 'id'], baseSort: (a, b) => a.index - b.index })
}

/**
 * Search keys, strongest first. Provider fields are capped at the weakest
 * rank, so a model-name match always outranks a provider-name match.
 */
const MODEL_KEYS: readonly KeyOption<ModelEntry>[] = [
  { key: 'name' },
  { key: 'id' },
  { key: 'providerName', maxRanking: rankings.MATCHES },
  { key: 'provider', maxRanking: rankings.MATCHES },
]

/** Preference facts that break ranking ties. */
export interface RankPreferences {
  readonly favorites: ReadonlySet<string>
  /** Most recent first. */
  readonly recents: readonly string[]
}

/**
 * Rank entries against a query. Every whitespace-separated term must match
 * one of the model name, model id, provider name, or provider id (exact,
 * prefix, word prefix, substring, acronym, or in-order characters, in that
 * rank order). Entries sort by summed term rank, then favorites, then
 * recency, then directory order.
 * @param entries - candidate entries.
 * @param query - the model search text.
 * @param prefs - favorites and recents.
 * @returns the matching entries, best first; the input for a blank query.
 */
export function rankModels(entries: readonly ModelEntry[], query: string, prefs: RankPreferences): readonly ModelEntry[] {
  const terms = query.trim().split(/\s+/).filter(term => term !== '')
  if (terms.length === 0) return entries
  let pool: readonly ModelEntry[] = entries
  const score = new Map<ModelEntry, number>()
  for (const term of terms) {
    const ranked = matchSorterWithRankInfo(pool, term, { keys: MODEL_KEYS })
    const next: ModelEntry[] = []
    for (const hit of ranked) {
      // Within one rank, a hit on an earlier key (the name) wins.
      score.set(hit.item, (score.get(hit.item) ?? 0) + hit.rank * 8 - Math.min(hit.keyIndex, 3))
      next.push(hit.item)
    }
    pool = next
  }
  const recency = new Map(prefs.recents.map((key, index) => [key, index]))
  return [...pool].sort((a, b) =>
    (score.get(b) ?? 0) - (score.get(a) ?? 0)
    || Number(prefs.favorites.has(b.key)) - Number(prefs.favorites.has(a.key))
    || (recency.get(a.key) ?? Infinity) - (recency.get(b.key) ?? Infinity)
    || a.order - b.order)
}

/** Inputs of {@link buildSections}. */
export interface SectionQuery extends RankPreferences {
  readonly entries: readonly ModelEntry[]
  readonly query: string
  /** Provider id to narrow to; undefined for all providers. */
  readonly provider: string | undefined
  /** Recents listed on top; 0 turns the section off. */
  readonly recentLimit: number
}

/**
 * Build the rendered sections. With a blank query: Favorites, then Recent
 * (favorites excluded), then every provider group in directory order. With
 * a query: one group per provider, ordered by each group's best hit, rows in
 * rank order. A provider filter narrows every section to that provider.
 * @param input - entries, query, provider filter, and preferences.
 * @returns non-empty sections.
 */
export function buildSections(input: SectionQuery): Section[] {
  const scoped = input.provider === undefined
    ? input.entries
    : input.entries.filter(entry => entry.provider === input.provider)
  const sections: Section[] = []
  const byKey = new Map(scoped.map(entry => [entry.key, entry]))
  const blank = input.query.trim() === ''
  if (blank) {
    const favorites = [...input.favorites].map(key => byKey.get(key)).filter((entry): entry is ModelEntry => entry !== undefined)
    if (favorites.length > 0) sections.push({ id: 'favorites', kind: 'favorites', entries: favorites })
    if (input.recentLimit > 0) {
      const recents = input.recents
        .filter(key => !input.favorites.has(key))
        .map(key => byKey.get(key))
        .filter((entry): entry is ModelEntry => entry !== undefined)
        .slice(0, input.recentLimit)
      if (recents.length > 0) sections.push({ id: 'recents', kind: 'recents', entries: recents })
    }
  }
  const ranked = rankModels(scoped, input.query, input)
  const groups = new Map<string, ModelEntry[]>()
  for (const entry of ranked) {
    const group = groups.get(entry.provider)
    if (group === undefined) groups.set(entry.provider, [entry])
    else group.push(entry)
  }
  let index = 0
  for (const [provider, entries] of groups) {
    sections.push({ id: `provider-${index++}`, kind: 'provider', provider, entries })
  }
  return sections
}

/**
 * Format a token count for a badge: `8K`, `128K`, `1M`, `1.05M`.
 * @param tokens - a positive token count.
 * @returns the compact label.
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${trim(tokens / 1000)}K`
  return String(tokens)
}

function trim(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}
