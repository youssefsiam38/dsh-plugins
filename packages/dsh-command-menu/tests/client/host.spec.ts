// @vitest-environment jsdom
/**
 * MenuHost on a real Cordis Context with fake client services: the facts it
 * gathers and what each entry does through those services.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_OFF } from '../../src/client/entries.ts'
import { MenuHost, REVEAL_TIMEOUT, findTextElement } from '../../src/client/host.ts'
import type { MenuEntry } from '../../src/client/model.ts'

vi.mock('@deepseek-ai/dsh-client-ui-slots', () => import('./slots-mock.ts'))

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function summary(id: string, extra: Record<string, unknown> = {}) {
  return { id, displayTitle: `Title ${id}`, running: false, blank: false, updatedAt: 1000, retainedBy: {}, ...extra }
}

function observable<T>(value: T) {
  const listeners = new Set<() => void>()
  let current = value
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { current = next; for (const listener of listeners) listener() },
  }
}

const COPY = {
  matchNotFound: (title: string) => `not found in ${title}`,
  failed: (reason: string) => `failed: ${reason}`,
  settingsUnavailable: 'no settings',
  settingsTrigger: () => 'Settings',
}

async function bench() {
  const ctx = new Context()
  const list = observable({
    ids: ['s1', 's2', 's3', 's4', 's5'],
    byId: {
      s1: summary('s1', { retainedBy: { mainView: 1 }, running: true, cwd: '/w' }),
      s2: summary('s2', { updatedAt: 5000 }),
      s3: summary('s3', { blank: true }),
      s4: summary('s4', { origin: 'subagent' }),
      s5: summary('s5'),
    },
  })
  const workspaces = observable({
    items: [{ workspaceId: 'w1', title: 'repo', path: '/w', sessionIds: ['s1', 's2', 's3', 's5'] }],
    archivedSessionIds: ['s5'],
  })
  const input = { setDraft: vi.fn(), submit: vi.fn(), focus: vi.fn() }
  const sessionCtx = new Context()
  sessionCtx.provide('conversation', { input: { for: () => input } })
  const cancel = vi.fn(() => Promise.resolve({ ok: true }))
  const search = vi.fn((query: string) => Promise.resolve(query === 'off'
    ? { ok: false, error: { code: 'session/search-disabled', message: 'session search is disabled' } }
    : { ok: true, value: { items: [{ sessionId: 's2', snippet: 'match here' }], hasMore: false } }))
  ctx.provide('sessions', {
    list,
    search,
    binding: (id: string) => id === 's1' ? { sessionId: id, ctx: sessionCtx, session: { cancel } } : undefined,
    subagentAddress: () => undefined,
  })
  ctx.provide('workspaces', { list: workspaces })
  const ui = { openSession: vi.fn(), startSession: vi.fn(), openWorkspace: vi.fn(() => Promise.resolve()), forkSession: vi.fn(() => Promise.resolve()) }
  ctx.provide('uiWorkspace', ui)
  const layout = { toggleSidebar: vi.fn() }
  ctx.provide('layout', layout)
  let theme = { preference: 'system', active: { id: 'light', colorScheme: 'light' }, themes: [{ id: 'light', colorScheme: 'light' }, { id: 'dark', colorScheme: 'dark' }] }
  const setTheme = vi.fn((id: string) => { theme = { ...theme, preference: id } })
  ctx.provide('theme', { getTheme: () => theme, setTheme })
  const slotListeners: Array<() => void> = []
  ctx.provide('slots', {
    entries: () => [
      { options: { id: 'models', order: 10, label: () => 'Models' } },
      { options: { id: 'general', order: 0, label: 'General' } },
    ],
    subscribe: (_key: string, listener: () => void) => { slotListeners.push(listener); return () => {} },
  })
  const modelStore = observable({
    current: { provider: 'e2e', model: 'echo' }, pending: null, groups: [{ id: 'e2e', name: 'E2E', models: [{ id: 'echo', name: 'Echo' }, { id: 'second', name: 'Second' }] }],
    failures: [], status: 'ready', error: null,
  })
  const select = vi.fn(() => Promise.resolve({ ok: true }))
  ctx.provide('modelDirectories', { directoryFor: () => ({ store: modelStore, load: () => Promise.resolve(modelStore.getSnapshot()), select }) })
  const listCommands = vi.fn(() => Promise.resolve({
    ok: true,
    value: [{ name: 'compact', description: 'Compact history' }, { name: 'goal', description: 'Set a goal', input: { hint: '<objective>' } }],
  }))
  ctx.reflect.provide('remote.commands', { list: listCommands })
  await ctx.plugin(function probe() {}).await()
  const host = new MenuHost(ctx, COPY)
  const stop = host.start()
  return { ctx, host, stop, list, input, cancel, search, ui, layout, setTheme, select, modelStore, listCommands }
}

const entry = (partial: Partial<MenuEntry> & Pick<MenuEntry, 'kind'>): MenuEntry =>
  ({ id: 'x', group: 'actions', title: 'T', icon: 'command', order: 0, ...partial })

describe('MenuHost facts', () => {
  it('lists visible sessions, the current one, workspaces, settings pages, and themes', async () => {
    const { host } = await bench()
    const facts = host.getSnapshot()
    expect(facts.currentSessionId).toBe('s1')
    expect(facts.sessions.map(session => [session.id, session.current, session.running, session.workspaceTitle])).toEqual([
      ['s1', true, true, 'repo'], ['s2', false, false, 'repo'],
    ])
    expect(facts.workspaces).toEqual([{ id: 'w1', title: 'repo', path: '/w', sessionCount: 2 }])
    expect(facts.settings).toEqual([{ id: 'general', label: 'General' }, { id: 'models', label: 'Models' }])
    expect(facts.themes).toEqual({ preference: 'system', active: 'light', options: [{ id: 'light', colorScheme: 'light' }, { id: 'dark', colorScheme: 'dark' }] })
    expect(facts.capabilities).toMatchObject({ newSession: true, sidebar: true, rightbar: false, settings: false, stop: true, focusComposer: true })
  })

  it('loads the current session commands and models when prepared, and follows list changes', async () => {
    const { host, list, listCommands } = await bench()
    expect(host.getSnapshot().commands.status).toBe('unavailable')
    host.prepare()
    await vi.waitFor(() => { expect(host.getSnapshot().commands.status).toBe('ready') })
    expect(listCommands).toHaveBeenCalledWith('s1')
    const models = host.getSnapshot().models
    expect(models.status === 'ready' && models.items.map(model => [model.id, model.current])).toEqual([['echo', true], ['second', false]])
    const seen = vi.fn()
    host.subscribe(seen)
    list.set({ ...list.getSnapshot(), ids: ['s2'] })
    expect(seen).toHaveBeenCalled()
    expect(host.getSnapshot().sessions.map(session => session.id)).toEqual(['s2'])
  })

  it('maps message search hits and flags a Host with search turned off', async () => {
    const { host } = await bench()
    const signal = new AbortController().signal
    await expect(host.searchMessages('needle', signal)).resolves.toEqual([{ sessionId: 's2', snippet: 'match here' }])
    await expect(host.searchMessages('off', signal)).rejects.toMatchObject({ name: SEARCH_OFF })
  })
})

describe('MenuHost actions', () => {
  it('runs a bare command through the composer and leaves an argument command for the user', async () => {
    const { host, input } = await bench()
    host.prepare()
    await vi.waitFor(() => { expect(host.getSnapshot().commands.status).toBe('ready') })
    await host.run(entry({ kind: 'command', ref: 'compact' }), '')
    expect(input.setDraft).toHaveBeenLastCalledWith('/compact')
    expect(input.submit).toHaveBeenCalledTimes(1)
    await host.run(entry({ kind: 'command', ref: 'goal' }), '')
    expect(input.setDraft).toHaveBeenLastCalledWith('/goal ')
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(input.submit).toHaveBeenCalledTimes(1)
  })

  it('switches the current session model and reports a refusal', async () => {
    const { host, select } = await bench()
    await expect(host.run(entry({ kind: 'model', ref: 'e2e\u0000second' }), '')).resolves.toEqual({ kind: 'done' })
    expect(select).toHaveBeenCalledWith({ provider: 'e2e', model: 'second' })
    select.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no key' } } as never)
    await expect(host.run(entry({ kind: 'model', ref: 'e2e\u0000second' }), '')).resolves.toEqual({ kind: 'notice', text: 'failed: no key' })
  })

  it('drives navigation, layout, theme, fork, and stop', async () => {
    const { host, ui, layout, setTheme, cancel, input } = await bench()
    await host.run(entry({ kind: 'session', ref: 's2' }), '')
    expect(ui.openSession).toHaveBeenCalledWith('s2')
    await host.run(entry({ kind: 'action', ref: 'new-session' }), '')
    await host.run(entry({ kind: 'action', ref: 'new-session-in:w1' }), '')
    expect(ui.startSession.mock.calls).toEqual([[], ['w1']])
    await host.run(entry({ kind: 'workspace', ref: 'w1' }), '')
    expect(ui.openWorkspace).toHaveBeenCalledWith('w1')
    await host.run(entry({ kind: 'action', ref: 'toggle-sidebar' }), '')
    expect(layout.toggleSidebar).toHaveBeenCalled()
    await host.run(entry({ kind: 'action', ref: 'toggle-theme' }), '')
    await host.run(entry({ kind: 'theme', ref: 'system' }), '')
    expect(setTheme.mock.calls).toEqual([['dark'], ['system']])
    await host.run(entry({ kind: 'action', ref: 'fork' }), '')
    expect(ui.forkSession).toHaveBeenCalledWith('s1')
    await host.run(entry({ kind: 'action', ref: 'stop' }), '')
    expect(cancel).toHaveBeenCalled()
    await host.run(entry({ kind: 'action', ref: 'focus-composer' }), '')
    expect(input.focus).toHaveBeenCalled()
  })

  it('turns a thrown service error into a notice', async () => {
    const { host, ui } = await bench()
    ui.openWorkspace.mockRejectedValueOnce(new Error('offline'))
    await expect(host.run(entry({ kind: 'workspace', ref: 'w1' }), '')).resolves.toEqual({ kind: 'notice', text: 'failed: offline' })
  })

  it('opens a settings page through the sidebar trigger and the dialog nav', async () => {
    const { host } = await bench()
    const clicked: string[] = []
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', 'Settings')
    trigger.addEventListener('click', () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.innerHTML = '<nav><button><svg></svg><span>General</span></button><button><span>Models</span></button></nav>'
      for (const button of dialog.querySelectorAll('button')) button.addEventListener('click', () => { clicked.push(button.textContent ?? '') })
      setTimeout(() => { document.body.appendChild(dialog) }, 20)
    })
    document.body.appendChild(trigger)
    host.prepare()
    expect(host.getSnapshot().capabilities.settings).toBe(true)
    await expect(host.run(entry({ kind: 'settings', ref: 'Models' }), '')).resolves.toEqual({ kind: 'done' })
    expect(clicked).toEqual(['Models'])
  })

  it('reports a missing settings panel', async () => {
    const { host } = await bench()
    await expect(host.run(entry({ kind: 'action', ref: 'open-settings' }), '')).resolves.toEqual({ kind: 'notice', text: 'no settings' })
  })

  it('opens a message hit and marks the match once the conversation shows it', async () => {
    const { host, ui } = await bench()
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scroller)
    const pending = host.run(entry({ kind: 'message', ref: 's2', title: 'Old chat' }), 'Parser Crash')
    setTimeout(() => { scroller.innerHTML = '<p>intro</p><p>then the parser crash happened</p>' }, 30)
    await expect(pending).resolves.toEqual({ kind: 'done' })
    expect(ui.openSession).toHaveBeenCalledWith('s2')
    expect(scroller.querySelector('[data-command-menu-hit]')?.textContent).toBe('then the parser crash happened')
  })

  it('says when the match is not loaded', async () => {
    vi.useFakeTimers()
    const { host } = await bench()
    const pending = host.run(entry({ kind: 'message', ref: 's2', title: 'Old chat' }), 'nowhere')
    await vi.advanceTimersByTimeAsync(REVEAL_TIMEOUT + 100)
    await expect(pending).resolves.toEqual({ kind: 'notice', text: 'not found in Old chat' })
  })

  it('finds text outside the menu only', () => {
    document.body.innerHTML = '<div data-command-menu><p>needle</p></div><section><span>A Needle here</span></section>'
    expect(findTextElement(document.body, 'needle')?.tagName).toBe('SPAN')
    expect(findTextElement(document.body, '')).toBeUndefined()
  })
})
