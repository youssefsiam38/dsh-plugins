// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PREFS_KEY, PrefsStore, parsePrefs } from '../../src/client/prefs.ts'
import { ProviderInsights, apiKeyRefOf, collectMeta, parseRoutes } from '../../src/client/insights.ts'
import type { InsightRemotes, WireResult } from '../../src/client/insights.ts'
import { modelKey } from '../../src/client/search.ts'

const A = modelKey('anthropic', 'claude-sonnet-4-5')
const B = modelKey('openrouter', 'openai/gpt-5')

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => { data.clear() },
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, value) },
  }
}

describe('PrefsStore', () => {
  it('toggles favorites and keeps recents most-recent-first without duplicates', () => {
    const storage = memoryStorage()
    const prefs = new PrefsStore(storage)
    const seen = vi.fn()
    prefs.subscribe(seen)
    prefs.toggleFavorite(A)
    prefs.toggleFavorite(B)
    prefs.toggleFavorite(A)
    prefs.pushRecent(A)
    prefs.pushRecent(B)
    prefs.pushRecent(A)
    expect(prefs.getSnapshot()).toEqual({ favorites: [B], recents: [A, B] })
    expect(seen).toHaveBeenCalledTimes(6)
    expect(new PrefsStore(storage).getSnapshot()).toEqual({ favorites: [B], recents: [A, B] })
  })

  it('keeps working in memory when storage throws', () => {
    const storage = memoryStorage()
    storage.getItem = () => { throw new Error('blocked') }
    storage.setItem = () => { throw new Error('quota') }
    const prefs = new PrefsStore(storage)
    prefs.toggleFavorite(A)
    expect(prefs.getSnapshot().favorites).toEqual([A])
  })

  it('ignores malformed stored values', () => {
    expect(parsePrefs('{')).toEqual({ favorites: [], recents: [] })
    expect(parsePrefs(JSON.stringify({ favorites: ['no-separator', 3, A, A], recents: 'x' }))).toEqual({ favorites: [A], recents: [] })
  })

  it('follows writes from other tabs', () => {
    const prefs = new PrefsStore(memoryStorage())
    const stop = prefs.start()
    window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY, newValue: JSON.stringify({ favorites: [B], recents: [] }) }))
    expect(prefs.getSnapshot().favorites).toEqual([B])
    stop()
  })
})

const ok = <T>(value: T): Promise<WireResult<T>> => Promise.resolve({ ok: true, value })

const ROUTES = [
  { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
  { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
  { provider: 'ollama', displayName: 'Ollama', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ollama'] },
  { provider: 'dormant', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'] },
]
const SETTINGS = {
  writable: true,
  namespaces: [{
    ns: 'llm-pi-ai',
    value: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' }, openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, ollama: {} } },
  }],
}

function remotes(overrides: Partial<InsightRemotes> = {}): InsightRemotes & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listConfigurableProviders: () => { calls.push('routes'); return ok(ROUTES) },
    describeSettings: () => { calls.push('settings'); return ok(SETTINGS) },
    describeCredentials: (refs) => {
      calls.push(`credentials:${refs.join(',')}`)
      return ok({ ANTHROPIC_API_KEY: { configured: true, writable: true }, OPENROUTER_API_KEY: { configured: false, writable: true } })
    },
    discoverModels: (ns, request) => {
      calls.push(`discover:${ns}:${request.provider}`)
      if (request.provider === 'ollama') return Promise.resolve({ ok: false, error: { code: 'llm/model-discovery-rejected', message: 'no baseURL' } })
      return ok(request.provider === 'anthropic'
        ? [{ id: 'claude-sonnet-4-5', contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text', 'image'] }]
        : [{ id: 'openai/gpt-5', contextWindow: 400_000, inputModalities: ['text'] }, { id: 7 }, { name: 'no id' }])
    },
    ...overrides,
  }
}

describe('ProviderInsights', () => {
  it('derives key status and metadata for the live providers', async () => {
    const remote = remotes()
    const insights = new ProviderInsights(() => remote, { metadata: true, providerStatus: true })
    await insights.ensure(['anthropic', 'openrouter', 'ollama', 'e2e'])
    const state = insights.getSnapshot()
    expect(Object.fromEntries(state.status)).toEqual({ anthropic: 'signed-in', openrouter: 'needs-key', ollama: 'ready', e2e: 'ready' })
    expect(state.meta.get(A)).toEqual({ contextWindow: 200_000, maxTokens: 64_000, vision: true })
    expect(state.meta.get(B)).toEqual({ contextWindow: 400_000, vision: false })
    expect(state.loading).toBe(false)
    // The dormant route is not listed, so it is never asked about.
    expect(remote.calls).not.toContain('discover:llm-pi-ai:dormant')
    expect(remote.calls).toContain('credentials:ANTHROPIC_API_KEY,OPENROUTER_API_KEY')
  })

  it('caches per provider set until invalidated', async () => {
    const remote = remotes()
    const insights = new ProviderInsights(() => remote, { metadata: true, providerStatus: true })
    await insights.ensure(['anthropic'])
    const first = remote.calls.length
    await insights.ensure(['anthropic'])
    expect(remote.calls.length).toBe(first)
    insights.invalidate()
    await insights.ensure(['anthropic'])
    expect(remote.calls.length).toBe(first * 2)
  })

  it('leaves facts unknown when namespaces are missing or fail', async () => {
    const insights = new ProviderInsights(() => ({}), { metadata: true, providerStatus: true })
    await insights.ensure(['anthropic'])
    expect(insights.getSnapshot().status.size).toBe(0)
    expect(insights.getSnapshot().meta.size).toBe(0)

    const failing = new ProviderInsights(() => remotes({
      describeSettings: () => Promise.reject(new Error('socket closed')),
      discoverModels: () => Promise.resolve({ ok: false, error: { code: 'x', message: 'y' } }),
    }), { metadata: true, providerStatus: true })
    await failing.ensure(['anthropic'])
    expect(failing.getSnapshot().status.size).toBe(0)
    expect(failing.getSnapshot().meta.size).toBe(0)
  })

  it('fetches nothing when both enrichments are off', async () => {
    const remote = remotes()
    const insights = new ProviderInsights(() => remote, { metadata: false, providerStatus: false })
    await insights.ensure(['anthropic'])
    expect(remote.calls).toEqual([])
  })

  it('drops a load that an invalidation overtook', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const remote = remotes({ listConfigurableProviders: async () => { await gate; return { ok: true, value: ROUTES } } })
    const insights = new ProviderInsights(() => remote, { metadata: true, providerStatus: true })
    const pending = insights.ensure(['anthropic'])
    insights.invalidate()
    release()
    await pending
    expect(insights.getSnapshot().status.size).toBe(0)
  })
})

describe('wire validation', () => {
  it('parses routes, profile references, and discovery answers defensively', () => {
    expect(parseRoutes([{ provider: 'a', settingsNs: 'ns', settingsPath: ['x'] }, { provider: 'b', settingsNs: '' }, null, { provider: 3 }]))
      .toEqual([{ provider: 'a', settingsNs: 'ns', settingsPath: ['x'] }])
    expect(apiKeyRefOf(SETTINGS, { provider: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] })).toBe('ANTHROPIC_API_KEY')
    expect(apiKeyRefOf({ namespaces: 'nope' }, { provider: 'a', settingsNs: 'llm-pi-ai', settingsPath: [] })).toBeUndefined()
    const meta = new Map()
    collectMeta('p', [{ id: 'm', contextWindow: -1, inputModalities: 'image' }, { id: 'n', contextWindow: 8192 }], meta)
    expect([...meta.entries()]).toEqual([[modelKey('p', 'n'), { contextWindow: 8192 }]])
  })
})
