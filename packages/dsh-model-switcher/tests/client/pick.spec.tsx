// @vitest-environment jsdom
/**
 * The `modelSwitcher` picker service on a real Cordis Context: `pick()`
 * resolves the chosen models, cancels, checks several up to `max`, leaves
 * excluded models out, and never selects a session model.
 */
import { Context } from '@deepseek-ai/cordis'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../../src/client/index.ts'
import type { WireResult } from '../../src/client/insights.ts'
import { en } from '../../src/client/locales.ts'
import type { ModelSwitcherKey } from '../../src/client/locales.ts'
import { parseCatalog, PickerCatalog } from '../../src/client/catalog.ts'
import { pickRequest } from '../../src/client/pick-service.ts'
import type { ModelRef, ModelSwitcherService } from '../../src/service.ts'
import { FAILURES, GROUPS } from './fixtures.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-mock.tsx'))

const translate = (key: ModelSwitcherKey, params: Record<string, string | number> = {}) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))

let fiber: { dispose(): Promise<unknown> } | undefined

afterEach(async () => {
  await act(async () => { await fiber?.dispose() })
  fiber = undefined
  await new Promise(resolve => setTimeout(resolve, 0))
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  localStorage.clear()
})

async function bench(catalog: () => Promise<WireResult<unknown>> = () => Promise.resolve({ ok: true, value: { default: GROUPS[0], groups: GROUPS, failures: [] } })) {
  const ctx = new Context()
  ctx.provide('slots', { inject: () => () => {}, register: () => () => {} })
  ctx.provide('locale', { register: () => () => {}, bind: () => translate })
  ctx.provide('sessions', { subagentAddress: () => undefined })
  ctx.provide('remote', { $on: () => () => {} })
  const modelCatalog = vi.fn(catalog)
  const selectModel = vi.fn()
  ctx.reflect.provide('remote.session', { modelCatalog, selectModel })
  const plugin = ctx.plugin({ inject: [...inject], apply })
  await plugin.await()
  await ctx.plugin(function probe() {}).await()
  fiber = plugin
  const service = ctx.get('modelSwitcher') as ModelSwitcherService | undefined
  if (service === undefined) throw new Error('modelSwitcher was not provided')
  return { ctx, service, modelCatalog, selectModel }
}

const dialog = () => screen.getByRole('dialog')
const rows = () => within(screen.getByRole('listbox', { name: 'Models' })).getAllByRole('option')
const row = (model: string) => rows().find(option => option.getAttribute('data-model') === model)!
const search = () => screen.getByRole('combobox', { name: 'Models' })

async function opened(): Promise<void> {
  await waitFor(() => { expect(rows().length).toBeGreaterThan(0) })
}

describe('modelSwitcher.pick', () => {
  it('resolves the chosen model without selecting a session model, and removes its surface', async () => {
    const b = await bench()
    const anchor = document.body.appendChild(document.createElement('button'))
    let result: Promise<ModelRef[] | undefined> | undefined
    await act(async () => { result = b.service.pick({ anchor }) })
    await opened()
    expect(dialog().getAttribute('aria-label')).toBe('Choose a model')
    expect(dialog().getAttribute('data-model-switcher-pick')).toBe('single')
    expect(document.activeElement).toBe(search())
    // The same list as the composer: every provider group, badges, no effort row.
    expect(rows()).toHaveLength(7)
    expect(screen.queryByRole('group', { name: 'Effort' })).toBeNull()
    fireEvent.change(search(), { target: { value: 'kimi' } })
    await act(async () => { fireEvent.keyDown(search(), { key: 'Enter' }) })
    await expect(result).resolves.toEqual([{ provider: 'openrouter', model: 'moonshotai/kimi-k2' }])
    await waitFor(() => { expect(document.querySelector('[data-model-switcher-picker]')).toBeNull() })
    expect(b.selectModel).not.toHaveBeenCalled()
    expect(b.modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('resolves undefined on Escape, on an outside pointer, and on plugin unload', async () => {
    const b = await bench()
    let result: Promise<ModelRef[] | undefined> | undefined
    await act(async () => { result = b.service.pick() })
    await opened()
    // No anchor: the popover is centered.
    expect(dialog().hasAttribute('data-centered')).toBe(true)
    await act(async () => { fireEvent.keyDown(search(), { key: 'Escape' }) })
    await expect(result).resolves.toBeUndefined()

    await act(async () => { result = b.service.pick() })
    await opened()
    const outside = document.body.appendChild(document.createElement('div'))
    await act(async () => { fireEvent.pointerDown(outside) })
    await expect(result).resolves.toBeUndefined()

    await act(async () => { result = b.service.pick() })
    await opened()
    await act(async () => { await fiber?.dispose() })
    fiber = undefined
    await expect(result).resolves.toBeUndefined()
  })

  it('cancels the open pick when another opens, and toggles closed on the same anchor', async () => {
    const b = await bench()
    const anchor = document.body.appendChild(document.createElement('button'))
    let first: Promise<ModelRef[] | undefined> | undefined
    let second: Promise<ModelRef[] | undefined> | undefined
    await act(async () => { first = b.service.pick({ anchor }) })
    await opened()
    await act(async () => { second = b.service.pick({ anchor }) })
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await act(async () => { first = b.service.pick({ anchor }) })
    await opened()
    await act(async () => { second = b.service.pick() })
    await expect(first).resolves.toBeUndefined()
    await waitFor(() => { expect(screen.getAllByRole('dialog')).toHaveLength(1) })
    await act(async () => { fireEvent.click(row('claude-haiku-4-5')) })
    await expect(second).resolves.toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5' }])
  })

  it('checks several models up to max and returns them in pick order on Done', async () => {
    const b = await bench()
    let result: Promise<ModelRef[] | undefined> | undefined
    await act(async () => { result = b.service.pick({ multiple: true, max: 2, title: 'Compare with' }) })
    await opened()
    expect(dialog().getAttribute('aria-label')).toBe('Compare with')
    expect(screen.getByRole('listbox', { name: 'Models' }).getAttribute('aria-multiselectable')).toBe('true')
    const done = () => document.querySelector<HTMLButtonElement>('[data-model-switcher-done]')!
    expect(done().disabled).toBe(true)
    expect(document.querySelector('[data-model-switcher-count]')?.textContent).toBe('0 of 2 selected')

    fireEvent.click(row('deepseek-v4-pro'))
    fireEvent.click(row('claude-haiku-4-5'))
    fireEvent.click(row('claude-haiku-4-5'))
    fireEvent.click(row('openai/gpt-5'))
    expect(row('openai/gpt-5').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-model-switcher-count]')?.textContent).toBe('2 of 2 selected')
    // Full: unchecked rows are disabled and do not toggle.
    expect(row('moonshotai/kimi-k2').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(row('moonshotai/kimi-k2'))
    expect(row('moonshotai/kimi-k2').getAttribute('aria-selected')).toBe('false')
    await act(async () => { fireEvent.click(done()) })
    await expect(result).resolves.toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'openrouter', model: 'openai/gpt-5' },
    ])
  })

  it('toggles with Enter and confirms with Ctrl+Enter', async () => {
    const b = await bench()
    let result: Promise<ModelRef[] | undefined> | undefined
    await act(async () => { result = b.service.pick({ multiple: true }) })
    await opened()
    fireEvent.change(search(), { target: { value: 'flash' } })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(document.querySelector('[data-model-switcher-count]')?.textContent).toBe('1 selected')
    await act(async () => { fireEvent.keyDown(search(), { key: 'Enter', ctrlKey: true }) })
    await expect(result).resolves.toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  })

  it('leaves excluded models out and starts with the initial ones checked', async () => {
    const b = await bench()
    let result: Promise<ModelRef[] | undefined> | undefined
    await act(async () => {
      result = b.service.pick({
        multiple: true,
        exclude: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }],
        initial: [{ provider: 'openrouter', model: 'moonshotai/kimi-k2' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }],
      })
    })
    await opened()
    expect(rows().map(option => option.getAttribute('data-model'))).not.toContain('claude-sonnet-4-5')
    expect(rows()).toHaveLength(5)
    // The Anthropic group is empty, so its provider option is gone too.
    fireEvent.focus(screen.getByRole('combobox', { name: 'Provider' }))
    expect(within(screen.getByRole('listbox', { name: 'Provider' })).getAllByRole('option').map(option => option.getAttribute('data-provider')))
      .toEqual(['', 'openrouter', 'deepseek-official'])
    expect(row('moonshotai/kimi-k2').getAttribute('aria-selected')).toBe('true')
    await act(async () => { fireEvent.click(document.querySelector('[data-model-switcher-done]')!) })
    await expect(result).resolves.toEqual([{ provider: 'openrouter', model: 'moonshotai/kimi-k2' }])
  })

  it('shows a catalog failure with Retry', async () => {
    let fail = true
    const b = await bench(() => Promise.resolve(fail
      ? { ok: false, error: { code: 'remote/unavailable', message: 'offline' } }
      : { ok: true, value: { groups: GROUPS, failures: FAILURES } }))
    await act(async () => { void b.service.pick() })
    await waitFor(() => { expect(screen.getByText('Could not load models: remote/unavailable: offline')).toBeTruthy() })
    fail = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    await opened()
    expect(screen.getByText('Groq failed to load: HTTP 401')).toBeTruthy()
  })
})

describe('picker catalog and options', () => {
  it('drops malformed catalog entries and refuses a non-catalog', () => {
    expect(parseCatalog({ groups: [GROUPS[0], { id: 1 }], failures: [FAILURES[0], 'x'] })).toEqual({ groups: [GROUPS[0]], failures: [FAILURES[0]] })
    expect(parseCatalog({ nope: true })).toBeUndefined()
  })

  it('reports a missing session namespace and reloads after invalidation', async () => {
    const missing = new PickerCatalog(() => undefined)
    await missing.load()
    expect(missing.getSnapshot()).toMatchObject({ status: 'error', error: 'session: the model catalog is not available' })

    const read = vi.fn(() => Promise.resolve({ ok: true as const, value: { groups: GROUPS, failures: [] } }))
    const catalog = new PickerCatalog(() => read)
    await catalog.load()
    await catalog.load()
    expect(read).toHaveBeenCalledTimes(1)
    catalog.invalidate()
    expect(catalog.getSnapshot().groups).toHaveLength(3)
    await catalog.load()
    expect(read).toHaveBeenCalledTimes(2)
    catalog.invalidate(true)
    expect(catalog.getSnapshot().groups).toEqual([])
  })

  it('normalizes caller options', () => {
    expect(pickRequest()).toEqual({ anchor: undefined, multiple: false, max: undefined, exclude: [], initial: [], title: undefined })
    expect(pickRequest({ multiple: true, max: 2.7, title: '  ' })).toMatchObject({ multiple: true, max: 2, title: undefined })
    expect(pickRequest({ max: 0 }).max).toBeUndefined()
    expect(pickRequest({ exclude: [{ provider: 'a', model: 'b' }, { provider: 1 } as never] }).exclude).toEqual([{ provider: 'a', model: 'b' }])
  })
})
