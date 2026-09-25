// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandMenu, MESSAGE_SEARCH_DELAY, highlight } from '../../src/client/CommandMenu.tsx'
import type { CommandMenuProps } from '../../src/client/CommandMenu.tsx'
import { SEARCH_OFF } from '../../src/client/entries.ts'
import type { MessageHit } from '../../src/client/entries.ts'
import type { MenuEntry } from '../../src/client/model.ts'
import { DEFAULT_SETTINGS } from '../../src/settings.ts'
import { FACTS, t } from './fixtures.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => import('./primitives-mock.tsx'))

beforeEach(() => {
  // jsdom has neither; the menu scrolls the active row and reads the sheet media query.
  Element.prototype.scrollIntoView = vi.fn()
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(overrides: Partial<CommandMenuProps> = {}) {
  const runs: Array<{ entry: MenuEntry; query: string }> = []
  const onClose = vi.fn()
  const onPage = vi.fn()
  const props: CommandMenuProps = {
    open: true,
    facts: FACTS,
    settings: DEFAULT_SETTINGS,
    recents: [],
    t,
    hotkeyKeys: ['Ctrl', 'K'],
    onRun: (entry, query) => { runs.push({ entry, query }) },
    onPage,
    onClose,
    ...overrides,
  }
  const view = render(<CommandMenu {...props} />)
  const input = screen.getByRole('combobox')
  const type = (value: string): void => { fireEvent.change(input, { target: { value } }) }
  const key = (name: string, init: Record<string, unknown> = {}): void => { fireEvent.keyDown(input, { key: name, ...init }) }
  const active = (): HTMLElement | null => {
    const id = input.getAttribute('aria-activedescendant')
    return id === null ? null : document.getElementById(id)
  }
  return { view, input, type, key, active, runs, onClose, onPage }
}

describe('CommandMenu', () => {
  it('is an accessible modal combobox over a grouped listbox, focused on open', () => {
    const { input, active } = mount()
    const dialog = screen.getByRole('dialog', { name: 'Command menu' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const listbox = screen.getByRole('listbox')
    expect(input.getAttribute('aria-controls')).toBe(listbox.id)
    expect(within(listbox).getAllByRole('group').map(group => group.getAttribute('aria-labelledby'))).not.toContain(null)
    expect(active()?.getAttribute('aria-selected')).toBe('true')
    expect(active()?.textContent).toContain('New session')
  })

  it('renders nothing while closed', () => {
    render(<CommandMenu {...{ open: false, facts: FACTS, settings: DEFAULT_SETTINGS, recents: [], t, hotkeyKeys: [], onRun: vi.fn(), onClose: vi.fn() }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves with arrows (wrapping) and runs the active row on Enter', () => {
    const { type, key, active, runs } = mount()
    type('login')
    expect(active()?.textContent).toContain('Fix login bug')
    key('ArrowUp')
    expect(active()?.textContent).toContain('Fix login bug')
    type('release')
    key('Enter')
    expect(runs.map(run => [run.entry.id, run.query])).toEqual([['session:s-run', 'release']])
  })

  it('supports Ctrl+N/Ctrl+P and ignores Enter during composition', () => {
    const { type, key, active, runs, input } = mount()
    type('>')
    const first = active()?.textContent
    key('n', { ctrlKey: true })
    expect(active()?.textContent).not.toBe(first)
    key('p', { ctrlKey: true })
    expect(active()?.textContent).toBe(first)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(runs).toEqual([])
  })

  it('opens a nested page, searches it, and goes back with Backspace or Escape before closing', () => {
    const { type, key, active, runs, onClose, onPage } = mount()
    type('switch model')
    key('Enter')
    expect(onPage).toHaveBeenCalledWith('models')
    expect(screen.getByRole('button', { name: 'Back' }).textContent).toContain('Switch model')
    expect(screen.getByRole('combobox').getAttribute('placeholder')).toBe('Search models…')
    type('gpt')
    expect(active()?.textContent).toContain('GPT-6')
    key('Enter')
    expect(runs[0]?.entry).toMatchObject({ kind: 'model', ref: 'openrouter\u0000openai/gpt-6' })
    type('')
    key('Backspace')
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    type('change theme')
    key('Enter')
    key('Escape')
    expect(onClose).not.toHaveBeenCalled()
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('narrows with a prefix and shows the scope', () => {
    const { type } = mount()
    type('#')
    expect(screen.getByText('Settings', { selector: '.dcm-scope' })).toBeTruthy()
    const options = screen.getAllByRole('option').map(option => option.getAttribute('data-entry-id'))
    expect(options).toEqual(['settings:general', 'settings:models', 'theme:system', 'theme:light', 'theme:dark'])
  })

  it('picking a scope row types its prefix', () => {
    const { type, key, input } = mount()
    type('?')
    key('ArrowDown')
    key('Enter')
    expect((input as HTMLInputElement).value).toBe('@')
  })

  it('lists recents first on a blank query', () => {
    mount({ recents: ['command:goal', 'session:s-old'] })
    const recent = screen.getByRole('group', { name: 'Recent' })
    expect(within(recent).getAllByRole('option').map(option => option.getAttribute('data-entry-id'))).toEqual(['command:goal', 'session:s-old'])
  })

  it('searches message text after a pause and lists hits last', async () => {
    vi.useFakeTimers()
    const searchMessages = vi.fn((_text: string, _signal: AbortSignal): Promise<readonly MessageHit[]> =>
      Promise.resolve([{ sessionId: 's-old', snippet: 'we saw the parser crash' }]))
    const { type } = mount({ searchMessages })
    type('p')
    type('pa')
    type('parser crash')
    expect(screen.getByText('Searching messages…')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_DELAY) })
    expect(searchMessages).toHaveBeenCalledTimes(1)
    expect(searchMessages.mock.calls[0]?.[0]).toBe('parser crash')
    const messages = screen.getByRole('group', { name: 'Messages' })
    expect(within(messages).getByRole('option').textContent).toContain('we saw the parser crash')
    expect(within(messages).getAllByText('parser').length).toBeGreaterThan(0)
  })

  it('says when the Host has message search turned off', async () => {
    vi.useFakeTimers()
    const off = Object.assign(new Error('session search is disabled'), { name: SEARCH_OFF })
    const { type } = mount({ searchMessages: () => Promise.reject(off) })
    type('anything')
    await act(async () => { await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_DELAY) })
    expect(screen.getByText(/turned off on this server/)).toBeTruthy()
  })

  it('keeps Tab inside and closes on a scrim press', () => {
    const { key, onClose, view } = mount()
    key('Tab')
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    fireEvent.pointerDown(view.baseElement.querySelector('.dcm-scrim')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('says what is missing without a session', () => {
    const { type } = mount({ facts: { ...FACTS, currentSessionId: undefined, commands: { status: 'unavailable' } } })
    type('>zzz')
    expect(screen.getByText('Open a session to use its commands and models')).toBeTruthy()
  })

  it('highlights query terms', () => {
    const { container } = render(<p>{highlight('Fix login bug', ['login', '('])}</p>)
    expect(container.querySelector('mark')?.textContent).toBe('login')
  })
})
