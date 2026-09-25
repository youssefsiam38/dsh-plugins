import { describe, expect, it } from 'vitest'
import {
  buildSections, filterProviders, formatTokens, modelEntries, modelKey, providerEntries, rankModels, selectionOfKey,
} from '../../src/client/search.ts'
import { FAILURES, GROUPS } from './fixtures.ts'

const entries = modelEntries(GROUPS, new Map([[modelKey('anthropic', 'claude-haiku-4-5'), { contextWindow: 200_000, vision: true }]]))
const none = { favorites: new Set<string>(), recents: [] as string[] }
const names = (list: readonly { name: string }[]) => list.map(entry => entry.name)

describe('entries', () => {
  it('flattens groups in directory order and attaches metadata', () => {
    expect(names(entries)).toEqual([
      'Claude Sonnet 4.5', 'Claude Haiku 4.5', 'GPT-5', 'Claude Opus 4', 'Kimi K2', 'DeepSeek V4 Flash', 'DeepSeek V4 Pro',
    ])
    expect(entries[1]).toMatchObject({ provider: 'anthropic', providerName: 'Anthropic', meta: { contextWindow: 200_000, vision: true } })
    expect(entries[0]?.reasoning?.defaultEffort).toBe('high')
  })

  it('round-trips row keys, including model ids with slashes', () => {
    expect(selectionOfKey(modelKey('openrouter', 'openai/gpt-5'))).toEqual({ provider: 'openrouter', model: 'openai/gpt-5' })
  })

  it('lists providers with counts and status, failed catalogs last', () => {
    const providers = providerEntries(GROUPS, FAILURES, new Map([['anthropic', 'signed-in'], ['openrouter', 'needs-key']]))
    expect(providers.map(provider => [provider.id, provider.count, provider.status])).toEqual([
      ['anthropic', 2, 'signed-in'], ['openrouter', 3, 'needs-key'], ['deepseek-official', 2, 'unknown'], ['groq', 0, 'error'],
    ])
    expect(providers.at(-1)?.message).toBe('HTTP 401')
  })

  it('filters providers by fuzzy name or id', () => {
    const providers = providerEntries(GROUPS, [], new Map())
    expect(filterProviders(providers, '').map(provider => provider.id)).toHaveLength(3)
    expect(filterProviders(providers, 'opr').map(provider => provider.id)).toEqual(['openrouter'])
    expect(filterProviders(providers, 'official').map(provider => provider.id)).toEqual(['deepseek-official'])
  })
})

describe('rankModels', () => {
  it('ranks exact and prefix name matches above fuzzy ones', () => {
    expect(names(rankModels(entries, 'kimi', none))).toEqual(['Kimi K2'])
    expect(names(rankModels(entries, 'claude', none)).slice(0, 3)).toEqual(['Claude Sonnet 4.5', 'Claude Haiku 4.5', 'Claude Opus 4'])
    expect(names(rankModels(entries, 'cso', none))[0]).toBe('Claude Sonnet 4.5')
  })

  it('matches model ids', () => {
    expect(names(rankModels(entries, 'v4-pro', none))).toEqual(['DeepSeek V4 Pro'])
    expect(names(rankModels(entries, 'openai/', none))).toEqual(['GPT-5'])
  })

  it('ranks a model-name hit above a provider-name hit', () => {
    // "Anthropic" is a provider name and a substring of an OpenRouter model id.
    const ranked = rankModels(entries, 'anthropic', none)
    expect(names(ranked)[0]).toBe('Claude Opus 4')
    expect(names(ranked)).toEqual(expect.arrayContaining(['Claude Sonnet 4.5', 'Claude Haiku 4.5']))
  })

  it('requires every term to match and lets provider terms narrow', () => {
    expect(names(rankModels(entries, 'openrouter claude', none))).toEqual(['Claude Opus 4'])
    expect(names(rankModels(entries, 'deepseek pro', none))).toEqual(['DeepSeek V4 Pro'])
    expect(rankModels(entries, 'zzz', none)).toEqual([])
  })

  it('breaks ties with favorites, then recency', () => {
    const flash = modelKey('deepseek-official', 'deepseek-v4-flash')
    const pro = modelKey('deepseek-official', 'deepseek-v4-pro')
    expect(names(rankModels(entries, 'deepseek v4', { favorites: new Set([pro]), recents: [] }))[0]).toBe('DeepSeek V4 Pro')
    expect(names(rankModels(entries, 'deepseek v4', { favorites: new Set(), recents: [pro, flash] }))[0]).toBe('DeepSeek V4 Pro')
    expect(names(rankModels(entries, 'deepseek v4', none))[0]).toBe('DeepSeek V4 Flash')
  })
})

describe('buildSections', () => {
  const opus = modelKey('openrouter', 'anthropic/claude-opus-4')
  const kimi = modelKey('openrouter', 'moonshotai/kimi-k2')
  const flash = modelKey('deepseek-official', 'deepseek-v4-flash')

  it('puts Favorites and Recent above the provider groups while the search is blank', () => {
    const sections = buildSections({ entries, query: '', provider: undefined, favorites: new Set([opus]), recents: [opus, flash, kimi], recentLimit: 1 })
    expect(sections.map(section => section.kind)).toEqual(['favorites', 'recents', 'provider', 'provider', 'provider'])
    expect(names(sections[0]!.entries)).toEqual(['Claude Opus 4'])
    expect(names(sections[1]!.entries)).toEqual(['DeepSeek V4 Flash'])
    expect(sections.slice(2).map(section => section.provider)).toEqual(['anthropic', 'openrouter', 'deepseek-official'])
  })

  it('turns the Recent section off at limit 0 and drops both with a query', () => {
    expect(buildSections({ entries, query: '', provider: undefined, favorites: new Set(), recents: [kimi], recentLimit: 0 })
      .some(section => section.kind === 'recents')).toBe(false)
    const searched = buildSections({ entries, query: 'k', provider: undefined, favorites: new Set([kimi]), recents: [kimi], recentLimit: 5 })
    expect(searched.every(section => section.kind === 'provider')).toBe(true)
  })

  it('orders provider groups by their best hit when searching', () => {
    const sections = buildSections({ entries, query: 'opus', provider: undefined, favorites: new Set(), recents: [], recentLimit: 5 })
    expect(sections.map(section => section.provider)).toEqual(['openrouter'])
    const claude = buildSections({ entries, query: 'claude', provider: undefined, favorites: new Set(), recents: [], recentLimit: 5 })
    expect(claude.map(section => section.provider)).toEqual(['anthropic', 'openrouter'])
  })

  it('narrows every section to the chosen provider', () => {
    const sections = buildSections({ entries, query: '', provider: 'openrouter', favorites: new Set([flash, opus]), recents: [], recentLimit: 5 })
    expect(sections.map(section => section.kind)).toEqual(['favorites', 'provider'])
    expect(names(sections[0]!.entries)).toEqual(['Claude Opus 4'])
    expect(names(sections[1]!.entries)).toEqual(['GPT-5', 'Claude Opus 4', 'Kimi K2'])
  })
})

describe('formatTokens', () => {
  it('formats context windows compactly', () => {
    expect([8192, 128_000, 200_000, 1_000_000, 1_048_576, 512].map(formatTokens)).toEqual(['8.19K', '128K', '200K', '1M', '1.05M', '512'])
  })
})
