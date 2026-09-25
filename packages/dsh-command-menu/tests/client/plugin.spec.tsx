// @vitest-environment jsdom
/**
 * The browser half on a real Cordis Context with fake slots and locale
 * services: what it registers, the global hotkey, and the overlay it renders.
 */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, pageSettings } from '../../src/client/index.ts'
import { en } from '../../src/client/locales.ts'
import { SETTINGS_GLOBAL } from '../../src/settings.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-mock.tsx'))
vi.mock('@deepseek-ai/dsh-client-ui-slots', () => import('./slots-mock.ts'))

interface Registration {
  name: string
  id?: string
  locale?: string
  inject: () => Record<string, unknown>
}

const page = globalThis as Record<string, unknown>

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  delete page[SETTINGS_GLOBAL]
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  localStorage.clear()
})

async function bench() {
  const ctx = new Context()
  const registrations: Array<{ registration: Registration; component: ComponentType<Record<string, unknown>> }> = []
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(registration: Registration, component: ComponentType<Record<string, unknown>>) {
      const record = { registration, component }
      registrations.push(record)
      return () => { registrations.splice(registrations.indexOf(record), 1) }
    },
  })
  const dictionaries: string[] = []
  ctx.provide('locale', {
    register(ns: string) { dictionaries.push(ns); return () => { dictionaries.splice(dictionaries.indexOf(ns), 1) } },
    bind: (ns: string) => (key: string, params: Record<string, unknown> = {}) => ns === 'command-menu'
      ? (en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name]))
      : key === 'trigger' ? 'Settings' : key,
  })
  const startSession = vi.fn()
  ctx.provide('uiWorkspace', { startSession, openSession: vi.fn(), openWorkspace: vi.fn(), forkSession: vi.fn() })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  const find = (name: string) => registrations.find(record => record.registration.name === name)
  const renderSlot = (name: string, extra: Record<string, unknown> = {}) => {
    const record = find(name)!
    const t = (key: string, params: Record<string, unknown> = {}) =>
      (en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_m, p: string) => String(params[p]))
    return render(createElement(record.component, { ...record.registration.inject(), t, ...extra }))
  }
  return { ctx, fiber, registrations, dictionaries, find, renderSlot, startSession }
}

describe('client plugin', () => {
  it('registers its dictionaries, stylesheet, overlay, and sidebar button, and removes its own effects on unload', async () => {
    const { fiber, registrations, dictionaries } = await bench()
    expect(dictionaries).toEqual(['command-menu'])
    expect(document.head.querySelector('style[data-plugin="dsh-command-menu"]')).not.toBeNull()
    expect(registrations.map(record => [record.registration.name, record.registration.id, record.registration.locale])).toEqual([
      ['shell.overlay', 'command-menu', 'command-menu'],
      ['sidebar.footer.action', 'command-menu', 'command-menu'],
    ])
    await fiber.dispose()
    // Slot registrations follow the real renderer's `slots.inject` lifetime, which this fake does not model.
    expect(dictionaries).toEqual([])
    expect(document.head.querySelector('style[data-plugin="dsh-command-menu"]')).toBeNull()
  })

  it('toggles on Ctrl+K from anywhere, including a text field, and yields when the key was taken', async () => {
    const { renderSlot } = await bench()
    renderSlot('shell.overlay')
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    act(() => { fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true }) })
    expect(screen.getByRole('dialog', { name: 'Command menu' })).toBeTruthy()
    act(() => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'k', code: 'KeyK', ctrlKey: true }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(field)

    field.addEventListener('keydown', (event) => { event.preventDefault() }, { once: true })
    act(() => { fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true }) })
    expect(screen.queryByRole('dialog')).toBeNull()

    const ignored = document.createElement('div')
    ignored.setAttribute('data-command-menu-ignore', '')
    const inner = document.createElement('input')
    ignored.appendChild(inner)
    document.body.appendChild(ignored)
    act(() => { fireEvent.keyDown(inner, { key: 'k', code: 'KeyK', ctrlKey: true }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from the sidebar button, runs an action after closing, and remembers it', async () => {
    const { renderSlot, startSession } = await bench()
    renderSlot('shell.overlay')
    renderSlot('sidebar.footer.action', { wide: true })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Command menu' })) })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new session' } })
    act(() => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(startSession).toHaveBeenCalledTimes(1) })
    expect(JSON.parse(localStorage.getItem('dsh-command-menu:recents') ?? '[]')).toEqual(['action:new-session'])
  })

  it('reads the hotkeys the Host published', () => {
    page[SETTINGS_GLOBAL] = { hotkeys: ['Mod+Shift+P', 'bogus key'], recentLimit: 0, groupLimit: 3, messageSearch: false }
    expect(pageSettings()).toEqual({ hotkeys: ['Mod+Shift+P'], recentLimit: 0, groupLimit: 3, messageSearch: false })
    page[SETTINGS_GLOBAL] = 'nonsense'
    expect(pageSettings().hotkeys).toEqual(['Mod+K'])
  })

  it('binds only the configured hotkey', async () => {
    page[SETTINGS_GLOBAL] = { hotkeys: ['Ctrl+Shift+P'] }
    const { renderSlot } = await bench()
    renderSlot('shell.overlay')
    act(() => { fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { fireEvent.keyDown(document.body, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
