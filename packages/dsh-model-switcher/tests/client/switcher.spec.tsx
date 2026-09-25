// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { ModelSwitcher } from '../../src/client/ModelSwitcher.tsx'
import type { DirectoryView, SelectOutcome, Translate } from '../../src/client/ModelSwitcher.tsx'
import { ProviderInsights } from '../../src/client/insights.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ModelSwitcherKey } from '../../src/client/locales.ts'
import { PrefsStore } from '../../src/client/prefs.ts'
import { modelKey } from '../../src/client/search.ts'
import { DEFAULT_SETTINGS } from '../../src/settings.ts'
import type { SwitcherSettings } from '../../src/settings.ts'
import { FAILURES, GROUPS } from './fixtures.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-mock.tsx'))

const t: Translate = (key: ModelSwitcherKey, params = {}) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))

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

/** A stand-in for the stock per-session directory: select() applies the selection like the Host projection would. */
class FakeDirectory {
  state: DirectoryView = { current: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, groups: GROUPS, failures: [], status: 'ready', error: null }
  readonly selections: ModelSelection[] = []
  loads = 0
  outcome: SelectOutcome = { ok: true }
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state
  set(next: Partial<DirectoryView>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
  load = () => { this.loads += 1 }
  select = (selection: ModelSelection): Promise<SelectOutcome> => {
    this.selections.push(selection)
    if (this.outcome?.ok === true) this.set({ current: selection })
    return Promise.resolve(this.outcome)
  }
}

let directory: FakeDirectory
let prefs: PrefsStore

function mount(options: { settings?: Partial<SwitcherSettings>; locked?: boolean; available?: boolean; insights?: ProviderInsights } = {}) {
  const insights = options.insights ?? new ProviderInsights(() => ({}), { metadata: false, providerStatus: false })
  return render(createElement(ModelSwitcher, {
    available: options.available ?? true,
    directory,
    load: directory.load,
    select: directory.select,
    prefs,
    insights,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    locked: options.locked ?? false,
    t,
  }))
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-model-switcher-trigger]')!
const modelSearch = () => screen.getByRole('combobox', { name: 'Models' })
const providerSearch = () => screen.getByRole('combobox', { name: 'Provider' })
const modelList = () => screen.getByRole('listbox', { name: 'Models' })
const activeOption = () => document.getElementById(modelSearch().getAttribute('aria-activedescendant') ?? '')

async function open(): Promise<void> {
  await act(async () => { fireEvent.click(trigger()) })
}

beforeEach(() => {
  directory = new FakeDirectory()
  prefs = new PrefsStore(memoryStorage())
})
afterEach(cleanup)

describe('trigger', () => {
  it('shows the current model and effort and opens with focus in the model search', async () => {
    mount()
    expect(trigger().getAttribute('aria-label')).toBe('Model: Claude Sonnet 4.5, effort High. Change model')
    expect(trigger().textContent).toContain('Claude Sonnet 4.5')
    await open()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(modelSearch())
    expect(directory.loads).toBe(1)
    const dialog = screen.getByRole('dialog', { name: 'Choose a model' })
    expect(dialog.getAttribute('aria-modal')).toBeNull()
    // The active row starts on the current model.
    expect(activeOption()?.getAttribute('data-model')).toBe('claude-sonnet-4-5')
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true')
  })

  it('renders nothing for sessions without model selection, and a disabled trigger while locked', () => {
    const { container } = mount({ available: false })
    expect(container.textContent).toBe('')
    cleanup()
    mount({ locked: true })
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })

  it('can open on the provider search', async () => {
    mount({ settings: { initialFocus: 'providers' } })
    await open()
    expect(document.activeElement).toBe(providerSearch())
    expect(providerSearch().getAttribute('aria-expanded')).toBe('true')
  })
})

describe('model list', () => {
  it('groups by provider, filters by fuzzy search, and exposes listbox semantics', async () => {
    mount()
    await open()
    const groups = within(modelList()).getAllByRole('group')
    expect(groups.map(group => group.getAttribute('aria-labelledby') !== null)).toEqual([true, true, true])
    expect(within(modelList()).getAllByRole('option')).toHaveLength(7)
    fireEvent.change(modelSearch(), { target: { value: 'opus' } })
    const options = within(modelList()).getAllByRole('option')
    expect(options.map(option => option.getAttribute('data-model'))).toEqual(['anthropic/claude-opus-4'])
    expect(activeOption()).toBe(options[0])
    fireEvent.change(modelSearch(), { target: { value: 'zzz' } })
    expect(screen.getByText('No model matches “zzz”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(within(modelList()).getAllByRole('option')).toHaveLength(7)
  })

  it('moves with arrows (wrapping) and PageDown, and selects with Enter', async () => {
    mount()
    await open()
    const search = modelSearch()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(activeOption()?.getAttribute('data-model')).toBe('claude-haiku-4-5')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(activeOption()?.getAttribute('data-model')).toBe('deepseek-v4-pro')
    fireEvent.keyDown(search, { key: 'PageUp' })
    expect(activeOption()?.getAttribute('data-model')).toBe('claude-sonnet-4-5')
    fireEvent.keyDown(search, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(search, { key: 'n', ctrlKey: true })
    expect(activeOption()?.getAttribute('data-model')).toBe('openai/gpt-5')
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    // The composer seat submits provider and model; the Host applies the model's own default effort.
    expect(directory.selections).toEqual([{ provider: 'openrouter', model: 'openai/gpt-5' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(prefs.getSnapshot().recents).toEqual([modelKey('openrouter', 'openai/gpt-5')])
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger())
    expect(trigger().textContent).toContain('GPT-5')
  })

  it('closes without a write when the current model is picked again', async () => {
    mount()
    await open()
    await act(async () => { fireEvent.keyDown(modelSearch(), { key: 'Enter' }) })
    expect(directory.selections).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('selects with a click and keeps the picker open with a toast when the Host refuses', async () => {
    directory.outcome = { ok: false, error: { code: 'session/writer-held', message: 'held' } }
    mount()
    await open()
    await act(async () => { fireEvent.click(within(modelList()).getByText('Kimi K2')) })
    expect(directory.selections).toEqual([{ provider: 'openrouter', model: 'moonshotai/kimi-k2' }])
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(en['error.sessionInUse'])).toBeTruthy()
    expect(prefs.getSnapshot().recents).toEqual([])
  })

  it('lists Favorites and Recent on top; Mod+S and the star toggle a favorite', async () => {
    prefs.pushRecent(modelKey('deepseek-official', 'deepseek-v4-pro'))
    mount()
    await open()
    expect(within(modelList()).getAllByRole('group')[0]?.getAttribute('data-section')).toBe('recents')
    fireEvent.keyDown(modelSearch(), { key: 'ArrowDown' })
    fireEvent.keyDown(modelSearch(), { key: 's', ctrlKey: true })
    expect(prefs.getSnapshot().favorites).toEqual([modelKey('anthropic', 'claude-haiku-4-5')])
    const sections = within(modelList()).getAllByRole('group').map(group => group.getAttribute('data-section'))
    expect(sections.slice(0, 2)).toEqual(['favorites', 'recents'])
    const star = within(modelList()).getAllByRole('option').find(option => option.getAttribute('data-model') === 'kimi-k2' || option.getAttribute('data-model') === 'moonshotai/kimi-k2')!
    fireEvent.click(star.querySelector('button')!)
    expect(prefs.getSnapshot().favorites).toContain(modelKey('openrouter', 'moonshotai/kimi-k2'))
    expect(directory.selections).toEqual([])
  })

  it('Escape clears the search first, then closes back to the trigger', async () => {
    mount()
    await open()
    fireEvent.change(modelSearch(), { target: { value: 'gpt' } })
    fireEvent.keyDown(modelSearch(), { key: 'Escape' })
    expect((modelSearch() as HTMLInputElement).value).toBe('')
    await act(async () => { fireEvent.keyDown(modelSearch(), { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger())
  })
})

describe('provider select', () => {
  it('filters providers, and picking one hands focus to the model search scoped to it', async () => {
    mount()
    await open()
    fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(providerSearch())
    const list = screen.getByRole('listbox', { name: 'Provider' })
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([
      expect.stringContaining('All providers'), expect.stringContaining('Anthropic'), expect.stringContaining('OpenRouter'), expect.stringContaining('DeepSeek'),
    ])
    expect(within(list).getAllByRole('option')[2]?.textContent).toContain('3 models')
    fireEvent.change(providerSearch(), { target: { value: 'opnr' } })
    expect(within(list).getAllByRole('option').map(option => option.getAttribute('data-provider'))).toEqual(['openrouter'])
    fireEvent.keyDown(providerSearch(), { key: 'Enter' })
    expect(document.activeElement).toBe(modelSearch())
    expect(modelSearch().getAttribute('placeholder')).toBe('Search OpenRouter models')
    expect(within(modelList()).getAllByRole('option').map(option => option.getAttribute('data-provider'))).toEqual(['openrouter', 'openrouter', 'openrouter'])
    // A query with no hit in the provider offers the all-providers search.
    fireEvent.change(modelSearch(), { target: { value: 'haiku' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search all providers' }))
    expect(within(modelList()).getAllByRole('option').map(option => option.getAttribute('data-model'))).toEqual(['claude-haiku-4-5'])
  })

  it('moves through providers with arrows and returns to all providers', async () => {
    mount()
    await open()
    fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(providerSearch(), { key: 'ArrowDown' })
    fireEvent.keyDown(providerSearch(), { key: 'ArrowDown' })
    const active = document.getElementById(providerSearch().getAttribute('aria-activedescendant') ?? '')
    expect(active?.getAttribute('data-provider')).toBe('openrouter')
    fireEvent.keyDown(providerSearch(), { key: 'Enter' })
    expect(within(modelList()).getAllByRole('option')).toHaveLength(3)
    fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(providerSearch(), { key: 'Home' })
    fireEvent.click(screen.getByRole('option', { name: /All providers/ }))
    expect(within(modelList()).getAllByRole('option')).toHaveLength(7)
  })

  it('shows key status and catalog failures', async () => {
    directory.set({ failures: FAILURES })
    const insights = new ProviderInsights(() => ({
      listConfigurableProviders: () => Promise.resolve({ ok: true, value: [{ provider: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] }] }),
      describeSettings: () => Promise.resolve({ ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } } }] } }),
      describeCredentials: () => Promise.resolve({ ok: true, value: { OPENROUTER_API_KEY: { configured: false } } }),
      discoverModels: () => Promise.resolve({ ok: true, value: [{ id: 'openai/gpt-5', contextWindow: 400_000, inputModalities: ['text', 'image'] }] }),
    }), { metadata: true, providerStatus: true })
    mount({ insights })
    await open()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.getByText('Groq failed to load: HTTP 401')).toBeTruthy()
    const gpt = within(modelList()).getAllByRole('option').find(option => option.getAttribute('data-model') === 'openai/gpt-5')!
    expect(within(gpt).getByText('400K').getAttribute('aria-label')).toBe('Context window 400000 tokens')
    expect(within(gpt).getByText('Vision')).toBeTruthy()
    expect(within(gpt).getByText('Reasoning')).toBeTruthy()
    expect(within(gpt).getByText('Needs key')).toBeTruthy()
    fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
    const list = screen.getByRole('listbox', { name: 'Provider' })
    const statuses = [...list.querySelectorAll('[data-status]')].map(node => node.getAttribute('data-status'))
    expect(statuses).toEqual(['ready', 'needs-key', 'ready', 'error'])
  })
})

describe('focus cycle and effort', () => {
  it('Tab cycles provider search, model search, and the effort buttons', async () => {
    mount()
    await open()
    fireEvent.keyDown(modelSearch(), { key: 'Tab' })
    expect(document.activeElement?.getAttribute('data-effort')).toBe('high')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement?.getAttribute('data-effort')).toBe('low')
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(providerSearch())
    fireEvent.keyDown(providerSearch(), { key: 'Tab' })
    expect(document.activeElement).toBe(modelSearch())
    fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(providerSearch(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.getAttribute('data-effort')).toBe('high')
  })

  it('sets the effort of the current model', async () => {
    mount()
    await open()
    const group = screen.getByRole('group', { name: 'Effort' })
    expect(within(group).getAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['Low', 'false'], ['High', 'true']])
    await act(async () => { fireEvent.click(within(group).getByText('Low')) })
    expect(directory.selections).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'low' }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers Default when the model has no default effort, and no effort row without reasoning metadata', async () => {
    directory.set({ current: { provider: 'openrouter', model: 'openai/gpt-5' } })
    mount()
    await open()
    expect(within(screen.getByRole('group', { name: 'Effort' })).getAllByRole('button').map(button => button.textContent)).toEqual(['Default', 'Minimal', 'Medium'])
    await act(async () => { fireEvent.keyDown(modelSearch(), { key: 'Escape' }) })
    directory.set({ current: { provider: 'openrouter', model: 'moonshotai/kimi-k2' } })
    await open()
    expect(screen.queryByRole('group', { name: 'Effort' })).toBeNull()
  })
})

describe('loading and errors', () => {
  it('shows loading, then a load error with Retry', async () => {
    directory.set({ current: null, groups: [], status: 'loading' })
    mount()
    expect(trigger().textContent).toContain('Loading models…')
    await open()
    expect(modelList().getAttribute('aria-busy')).toBe('true')
    expect(within(modelList()).getByText('Loading models…')).toBeTruthy()
    act(() => { directory.set({ status: 'error', error: 'gateway/internal: down' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(directory.loads).toBe(2)
  })
})

describe('narrow screens', () => {
  it('opens as a modal bottom sheet with a close button in the focus cycle', async () => {
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    vi.stubGlobal('matchMedia', matchMedia)
    try {
      mount()
      await open()
      const dialog = screen.getByRole('dialog')
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(dialog.hasAttribute('data-sheet')).toBe(true)
      fireEvent.keyDown(modelSearch(), { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(providerSearch())
      fireEvent.keyDown(providerSearch(), { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('locales', () => {
  it('zh covers every key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
