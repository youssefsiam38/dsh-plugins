/**
 * Optional enrichment beyond the shared model directory, read from Remote
 * namespaces the stock Web client already mounts:
 * - provider key status: `llm.listConfigurableProviders` names each route's
 *   settings address, `settings.describe` (secrets redacted) gives the
 *   profile's `apiKeyEnv` reference, and `credentials.describe` says whether
 *   that reference holds a value;
 * - model metadata: `llm.discoverModels(settingsNs, { provider })`, which
 *   answers a catalog route from its installed catalog (context window,
 *   output cap, input types).
 * Every read is best-effort: a missing namespace, a refusal, or malformed data
 * leaves the corresponding facts unknown and the picker works without them.
 * Nothing here writes.
 * @module dsh-model-switcher/client/insights
 */

import { modelKey } from './search.ts'
import type { ModelMeta, ProviderStatus } from './search.ts'

/** A Remote call outcome as the Gateway returns it. */
export type WireResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The Remote calls this module uses; each is absent when its namespace is not mounted. */
export interface InsightRemotes {
  readonly listConfigurableProviders?: () => Promise<WireResult<unknown>>
  readonly discoverModels?: (settingsNs: string, request: { provider: string }) => Promise<WireResult<unknown>>
  readonly describeSettings?: () => Promise<WireResult<unknown>>
  readonly describeCredentials?: (refs: string[]) => Promise<WireResult<unknown>>
}

/** Which enrichments to fetch. */
export interface InsightOptions {
  readonly metadata: boolean
  readonly providerStatus: boolean
}

/** Enrichment snapshot. */
export interface InsightState {
  /** Key status by provider id; providers absent here are `unknown`. */
  readonly status: ReadonlyMap<string, ProviderStatus>
  /** Disclosed metadata by row key. */
  readonly meta: ReadonlyMap<string, ModelMeta>
  /** Whether a load is in flight. */
  readonly loading: boolean
}

/** One configurable route's settings address (validated wire data). */
interface RouteAddress {
  readonly provider: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}

const EMPTY: InsightState = { status: new Map(), meta: new Map(), loading: false }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function settle<T>(call: (() => Promise<WireResult<T>>) | undefined): Promise<T | undefined> {
  if (call === undefined) return undefined
  try {
    const result = await call()
    return result.ok ? result.value : undefined
  } catch (error: unknown) {
    // A transport failure is an unknown fact, never a picker failure.
    void error
    return undefined
  }
}

/**
 * Validate the configurable-provider directory.
 * @param value - raw `llm.listConfigurableProviders` value.
 * @returns the routes with a settings address.
 */
export function parseRoutes(value: unknown): RouteAddress[] {
  if (!Array.isArray(value)) return []
  const routes: RouteAddress[] = []
  for (const item of value) {
    const entry = record(item)
    if (entry === undefined) continue
    const { provider, settingsNs, settingsPath } = entry
    if (typeof provider !== 'string' || typeof settingsNs !== 'string' || settingsNs === '') continue
    const path = Array.isArray(settingsPath) && settingsPath.every(part => typeof part === 'string') ? settingsPath as string[] : []
    routes.push({ provider, settingsNs, settingsPath: path })
  }
  return routes
}

/**
 * Read the credential reference a route's resolved profile names.
 * @param describe - raw `settings.describe` value.
 * @param route - the route's settings address.
 * @returns the `apiKeyEnv` reference, or undefined when the profile names none.
 */
export function apiKeyRefOf(describe: unknown, route: RouteAddress): string | undefined {
  const namespaces = record(describe)?.['namespaces']
  if (!Array.isArray(namespaces)) return undefined
  const view = namespaces.map(record).find(item => item?.['ns'] === route.settingsNs)
  let node: unknown = view?.['value']
  for (const part of route.settingsPath) node = record(node)?.[part]
  const ref = record(node)?.['apiKeyEnv']
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/**
 * Validate one discovery answer into metadata by row key.
 * @param provider - the route the answer describes.
 * @param value - raw `llm.discoverModels` value.
 * @param into - the map to add entries to.
 */
export function collectMeta(provider: string, value: unknown, into: Map<string, ModelMeta>): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    const entry = record(item)
    if (entry === undefined || typeof entry['id'] !== 'string') continue
    const contextWindow = positive(entry['contextWindow'])
    const maxTokens = positive(entry['maxTokens'])
    const input = entry['inputModalities']
    const vision = Array.isArray(input) ? input.includes('image') : undefined
    const meta: ModelMeta = {
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...vision === undefined ? {} : { vision },
    }
    if (Object.keys(meta).length > 0) into.set(modelKey(provider, entry['id']), meta)
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Loads and caches enrichment for the current Host generation. */
export class ProviderInsights {
  private state: InsightState = EMPTY
  private readonly listeners = new Set<() => void>()
  private generation = 0
  /** Providers the last completed or in-flight load covered; undefined when stale. */
  private covered: string | undefined

  /**
   * @param remotes - Remote calls, resolved lazily so a namespace mounted later is used.
   * @param options - which enrichments to fetch.
   */
  constructor(private readonly remotes: () => InsightRemotes, private readonly options: InsightOptions) {}

  /** @returns the current snapshot. */
  getSnapshot = (): InsightState => this.state

  /**
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Mark the cache stale (a Host model, settings, or credential input changed); the next {@link ensure} reloads. */
  invalidate(): void {
    this.generation += 1
    this.covered = undefined
    if (this.state.loading) this.set({ ...this.state, loading: false })
  }

  /**
   * Load enrichment for these live providers unless the cache already covers them.
   * @param providers - provider ids listed in the directory.
   * @returns a promise that settles when the load finishes (never rejects).
   */
  async ensure(providers: readonly string[]): Promise<void> {
    if (!this.options.metadata && !this.options.providerStatus) return
    const cover = [...providers].sort().join('\n')
    if (this.covered === cover) return
    this.covered = cover
    const generation = ++this.generation
    this.set({ ...this.state, loading: true })
    const remotes = this.remotes()
    const live = new Set(providers)
    const routes = parseRoutes(await settle(remotes.listConfigurableProviders)).filter(route => live.has(route.provider))
    const [status, meta] = await Promise.all([
      this.options.providerStatus ? this.loadStatus(remotes, routes, providers) : Promise.resolve(new Map<string, ProviderStatus>()),
      this.options.metadata ? this.loadMeta(remotes, routes) : Promise.resolve(new Map<string, ModelMeta>()),
    ])
    if (generation !== this.generation) return
    this.set({ status, meta, loading: false })
  }

  private async loadStatus(remotes: InsightRemotes, routes: readonly RouteAddress[], providers: readonly string[]): Promise<Map<string, ProviderStatus>> {
    const status = new Map<string, ProviderStatus>()
    if (remotes.describeSettings === undefined || remotes.describeCredentials === undefined) return status
    const describe = await settle(remotes.describeSettings)
    if (describe === undefined) return status
    const refs = new Map<string, string | undefined>(routes.map(route => [route.provider, apiKeyRefOf(describe, route)]))
    const named = [...new Set([...refs.values()].filter((ref): ref is string => ref !== undefined))]
    const credentials = named.length === 0 ? {} : record(await settle(() => remotes.describeCredentials!(named)))
    for (const provider of providers) {
      // A live route without a settings address, or whose profile names no
      // reference, authenticates through the provider's own path.
      const ref = refs.get(provider)
      if (ref === undefined) {
        status.set(provider, 'ready')
        continue
      }
      const configured = record(credentials?.[ref])?.['configured']
      if (typeof configured === 'boolean') status.set(provider, configured ? 'signed-in' : 'needs-key')
    }
    return status
  }

  private async loadMeta(remotes: InsightRemotes, routes: readonly RouteAddress[]): Promise<Map<string, ModelMeta>> {
    const meta = new Map<string, ModelMeta>()
    const discover = remotes.discoverModels
    if (discover === undefined) return meta
    const answers = await Promise.all(routes.map(route =>
      settle(() => discover(route.settingsNs, { provider: route.provider })).then(value => [route.provider, value] as const)))
    for (const [provider, value] of answers) collectMeta(provider, value, meta)
    return meta
  }

  private set(next: InsightState): void {
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}
