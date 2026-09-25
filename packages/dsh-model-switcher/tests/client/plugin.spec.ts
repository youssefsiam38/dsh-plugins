// @vitest-environment jsdom
/**
 * The browser half on a real Cordis Context with fake composer, locale,
 * session, directory, and Remote services: what it registers, where, and how
 * it behaves when the stock model-selection service is absent.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { apply, inject, insightRemotes, pageSettings } from '../../src/client/index.ts'
import type { SwitcherFace } from '../../src/client/ModelSwitcher.tsx'
import { SETTINGS_GLOBAL } from '../../src/settings.ts'
import { GROUPS } from './fixtures.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-mock.tsx'))

interface Registration {
  name: string
  priority?: number
  locale?: string
  registrant?: string
  inject: (sessionId: string) => SwitcherFace
}

const page = globalThis as Record<string, unknown>

afterEach(() => {
  delete page[SETTINGS_GLOBAL]
  document.head.innerHTML = ''
})

async function bench(options: { directories?: boolean } = {}) {
  const ctx = new Context()
  const registrations: Registration[] = []
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(registration: Registration) {
      registrations.push(registration)
      return () => { registrations.splice(registrations.indexOf(registration), 1) }
    },
  })
  const dictionaries: string[] = []
  ctx.provide('locale', {
    register(ns: string) { dictionaries.push(ns); return () => { dictionaries.splice(dictionaries.indexOf(ns), 1) } },
    bind: () => (key: string) => key,
  })
  ctx.provide('sessions', { subagentAddress: (id: string) => id === 'child' ? { parentSessionId: 'parent' } : undefined })
  const listeners = new Map<string, () => void>()
  ctx.provide('remote', {
    $on(event: string, listener: () => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  })
  const discover = vi.fn(() => Promise.resolve({ ok: true, value: [{ id: 'claude-sonnet-4-5', contextWindow: 200_000 }] }))
  ctx.reflect.provide('remote.session', {})
  ctx.reflect.provide('remote.llm', {
    listConfigurableProviders: () => Promise.resolve({ ok: true, value: [{ provider: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: [] }] }),
    discoverModels: discover,
  })
  const selections: ModelSelection[] = []
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({ current: null, groups: GROUPS, failures: [], status: 'ready' as const, error: null }),
  }
  const directories = {
    directoryFor: () => ({
      store,
      load: () => Promise.resolve(store.getSnapshot()),
      select: (selection: ModelSelection) => { selections.push(selection); return Promise.resolve({ ok: true as const, value: undefined }) },
    }),
  }
  if (options.directories !== false) ctx.provide('modelDirectories', directories)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  return { ctx, fiber, registrations, dictionaries, listeners, selections, discover, directories }
}

describe('client plugin', () => {
  it('registers in the composer model seat below the stock priority, with its copy and styles', async () => {
    const b = await bench()
    expect(b.registrations.map(({ name, priority, locale, registrant }) => ({ name, priority, locale, registrant }))).toEqual([
      { name: 'conversation.input.model', priority: -10, locale: 'model-switcher', registrant: 'dsh-model-switcher' },
    ])
    expect(b.dictionaries).toEqual(['model-switcher'])
    expect(document.head.querySelector('style[data-plugin="dsh-model-switcher"]')).not.toBeNull()
    expect([...b.listeners.keys()].sort()).toEqual(['credentials/record-updated', 'credentials/reference-updated', 'llm/adapters-updated', 'settings/document-updated'])

    const face = b.registrations[0]!.inject('s1')
    expect(face.available).toBe(true)
    await face.select({ provider: 'anthropic', model: 'claude-haiku-4-5' })
    expect(b.selections).toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5' }])
    expect(b.registrations[0]!.inject('child').available).toBe(false)
    expect(await b.registrations[0]!.inject('child').select({ provider: 'a', model: 'b' })).toBeUndefined()

    // Pushed invalidations make the next open reload enrichment.
    await face.insights.ensure(['anthropic'])
    expect(b.discover).toHaveBeenCalledTimes(1)
    b.listeners.get('llm/adapters-updated')!()
    await face.insights.ensure(['anthropic'])
    expect(b.discover).toHaveBeenCalledTimes(2)

    // The real `slots.inject` binds its effect to the caller's fiber; this fake does not, so only the plugin's own effects are checked.
    await b.fiber.dispose()
    expect(b.listeners.size).toBe(0)
    expect(document.head.querySelector('style[data-plugin="dsh-model-switcher"]')).toBeNull()
  })

  it('stays out of the seat until the stock model-selection service exists', async () => {
    const b = await bench({ directories: false })
    expect(b.registrations).toEqual([])
    b.ctx.provide('modelDirectories', b.directories)
    await b.ctx.plugin(function probe() {}).await()
    expect(b.registrations.map(registration => registration.name)).toEqual(['conversation.input.model'])
  })

  it('reads the Host-published settings, falling back per field', async () => {
    page[SETTINGS_GLOBAL] = { priority: -3, recentLimit: 99, initialFocus: 'providers', providerIcons: { a: 'https://x/a.png', b: 'javascript:alert(1)' } }
    expect(pageSettings()).toMatchObject({ priority: -3, recentLimit: 5, initialFocus: 'providers', providerIcons: { a: 'https://x/a.png' } })
    const b = await bench()
    expect(b.registrations[0]!.priority).toBe(-3)
  })

  it('binds only the Remote reads whose namespaces are mounted', () => {
    const ctx = new Context()
    expect(insightRemotes(ctx)).toEqual({})
    ctx.reflect.provide('remote.llm', { listConfigurableProviders: () => Promise.resolve({ ok: true, value: [] }) })
    expect(Object.keys(insightRemotes(ctx))).toEqual(['listConfigurableProviders'])
  })
})
