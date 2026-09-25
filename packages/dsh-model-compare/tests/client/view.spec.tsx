// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { CompareApi } from '../../src/client/api.ts'
import type { Fetcher } from '../../src/client/api.ts'
import { CompareView } from '../../src/client/CompareView.tsx'
import type { CompareDeps } from '../../src/client/CompareView.tsx'
import { LaneView, laneStatus } from '../../src/client/Lane.tsx'
import type { LaneOwnerProps } from '../../src/client/Lane.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { ModelCompareKey } from '../../src/client/locales.ts'
import type { ModelPicker, PickedRef, PickRequest } from '../../src/client/picker.ts'
import { parseSwitcherPrefs, readSwitcherPrefs, SWITCHER_PREFS_KEY } from '../../src/client/prefs.ts'
import { catalogRows, listRows } from '../../src/client/Setup.tsx'
import type { Translate } from '../../src/client/Setup.tsx'
import { seconds, tokens, usd } from '../../src/client/format.ts'
import { foldTranscript } from '../../src/client/transcript.ts'
import type { WindowEntry } from '../../src/client/transcript.ts'
import type { CompareRecord, CompareStateResponse, LaneStatsView } from '../../src/types.ts'

// The dsh Web shell provides the primitives at runtime; tests use a plain stand-in.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    MarkdownText: ({ text }: { text: string }) => react.createElement('p', { 'data-markdown': '' }, text),
  }
})

afterEach(cleanup)

const t: Translate = (key: ModelCompareKey, params = {}) => en[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))

const STATE: CompareStateResponse = {
  settings: { minModels: 2, maxModels: 3, tools: 'none', maxPromptChars: 1000, maxOutputTokens: 8192 },
  catalog: {
    default: { provider: 'p', model: 'a' },
    groups: [{
      id: 'p',
      name: 'Provider',
      models: [
        { id: 'a', name: 'Alpha', efforts: [] },
        { id: 'b', name: 'Beta', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        { id: 'c', name: 'Gamma', efforts: [] },
        { id: 'd', name: 'Delta', efforts: [] },
      ],
    }],
    failures: [],
  },
  compare: null,
}

const RECORD: CompareRecord = {
  compareId: 'cmp-1',
  sourceSessionId: 'source',
  prompt: 'which is best?',
  createdAt: 1,
  tools: 'none',
  status: 'open',
  lanes: [
    { sessionId: 'lane-a', provider: 'p', model: 'a', label: 'Alpha' },
    { sessionId: 'lane-b', provider: 'p', model: 'b', reasoningEffort: 'high', label: 'Beta · High' },
  ],
}

function fakeApi(): { api: CompareApi; calls: Array<{ path: string; body: Record<string, unknown> }>; state: { compare: CompareRecord | null } } {
  const state: { compare: CompareRecord | null } = { compare: null }
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetcher: Fetcher = (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ path: input, body })
    const reply = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }))
    switch (input) {
      case 'api/model-compare/state': return reply({ ...STATE, compare: state.compare })
      case 'api/model-compare/start':
        state.compare = RECORD
        return reply({ compare: RECORD })
      case 'api/model-compare/adopt':
        state.compare = null
        return reply({ sessionId: 'continued' })
      case 'api/model-compare/discard':
        state.compare = null
        return reply({ ok: true })
      case 'api/model-compare/stop': return reply({ stopped: ['lane-a'] })
      default: return reply({ error: 'nope' }, 404)
    }
  }
  return { api: new CompareApi(fetcher), calls, state }
}

function deps(api: CompareApi, opened: string[], picker?: ModelPicker): CompareDeps {
  return {
    picker: () => picker,
    api,
    prefs: () => ({ favorites: [{ provider: 'p', model: 'c' }], recents: [] }),
    retain: sessionId => ({ sessionId, release: vi.fn() }) as unknown as SessionReference,
    open: (sessionId) => {
      opened.push(sessionId)
      return true
    },
  }
}

function renderLane(reference: SessionReference, owner: LaneOwnerProps) {
  return createElement('div', { 'data-lane': reference.sessionId },
    createElement('button', { type: 'button', onClick: owner.onAdopt }, `adopt ${owner.lane.label}`),
    createElement('button', { type: 'button', onClick: owner.onStop }, `stop ${owner.lane.label}`))
}

describe('Compare view', () => {
  it('picks models (favorites first), sends the start request, then shows one column per lane', async () => {
    const { api, calls } = fakeApi()
    const opened: string[] = []
    render(createElement(CompareView, { sessionId: 'source', deps: deps(api, opened), renderLane, t }))
    await screen.findByText('Compare models')
    // The catalog default is preselected.
    expect(document.querySelector('[data-model-compare-chip="p/a"]')).not.toBeNull()
    const search = screen.getByRole('combobox', { name: 'Search models' })
    fireEvent.focus(search)
    const options = [...document.querySelectorAll('[data-model-compare-option]')].map(option => option.getAttribute('data-model-compare-option'))
    expect(options[0]).toBe('p/c')
    expect(screen.getByText('Favorites')).toBeDefined()
    fireEvent.change(search, { target: { value: 'bet' } })
    fireEvent.click(document.querySelector('[data-model-compare-option="p/b"]')!)
    fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning effort for Beta' }), { target: { value: 'high' } })
    const start = document.querySelector<HTMLButtonElement>('[data-model-compare-start]')!
    expect(start.disabled).toBe(true)
    fireEvent.change(document.querySelector('[data-model-compare-prompt]')!, { target: { value: '  which is best?  ' } })
    expect(screen.getByText(/2 models will each answer/)).toBeDefined()
    expect(screen.getByText(/Tools are off/)).toBeDefined()
    fireEvent.click(start)
    await waitFor(() => { expect(document.querySelectorAll('[data-lane]')).toHaveLength(2) })
    expect(calls.find(call => call.path === 'api/model-compare/start')?.body).toEqual({
      sessionId: 'source',
      prompt: 'which is best?',
      models: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b', reasoningEffort: 'high' }],
    })
    expect(screen.getByText('which is best?')).toBeDefined()

    fireEvent.click(screen.getByText('stop Alpha'))
    await waitFor(() => { expect(calls.some(call => call.path === 'api/model-compare/stop' && call.body['laneSessionId'] === 'lane-a')).toBe(true) })
    fireEvent.click(screen.getByText('adopt Beta · High'))
    await waitFor(() => { expect(opened).toEqual(['continued']) })
    expect(calls.find(call => call.path === 'api/model-compare/adopt')?.body).toEqual({ compareId: 'cmp-1', laneSessionId: 'lane-b' })
    await screen.findByText('Compare models')
  })

  it('stops at the configured model count and shows Host errors', async () => {
    const { api } = fakeApi()
    const failing = new CompareApi(() => Promise.resolve(new Response(JSON.stringify({ error: 'The comparison could not start: boom' }), { status: 500 })))
    const view = deps(api, [])
    render(createElement(CompareView, { sessionId: 'source', deps: { ...view, api: Object.assign(Object.create(api) as CompareApi, { start: failing.start.bind(failing) }) }, renderLane, t }))
    await screen.findByText('Compare models')
    const search = screen.getByRole('combobox', { name: 'Search models' })
    for (const id of ['b', 'c']) {
      fireEvent.focus(search)
      fireEvent.click(document.querySelector(`[data-model-compare-option="p/${id}"]`)!)
    }
    expect((screen.getByRole('combobox', { name: 'Search models' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByPlaceholderText('Up to 3 models')).toBeDefined()
    fireEvent.change(document.querySelector('[data-model-compare-prompt]')!, { target: { value: 'x' } })
    fireEvent.click(document.querySelector('[data-model-compare-start]')!)
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
  })

  it('opens the model switcher picker when it is installed, keeping effort per model', async () => {
    const { api, calls } = fakeApi()
    const answers: Array<PickedRef[] | undefined> = [
      undefined,
      [{ provider: 'p', model: 'b' }, { provider: 'gone', model: 'x' }, { provider: 'p', model: 'c' }],
      [{ provider: 'p', model: 'd' }],
    ]
    const requests: PickRequest[] = []
    const picker: ModelPicker = {
      pick: vi.fn((request?: PickRequest) => {
        requests.push(request ?? {})
        return Promise.resolve(answers.shift())
      }),
    }
    render(createElement(CompareView, { sessionId: 'source', deps: deps(api, [], picker), renderLane, t }))
    await screen.findByText('Compare models')
    // No built-in list: models come from the picker.
    expect(screen.queryByRole('combobox', { name: 'Search models' })).toBeNull()
    const add = document.querySelector<HTMLButtonElement>('[data-model-compare-add]')!
    expect(add.textContent).toBe('Add models')

    // A cancelled pick changes nothing.
    await act(async () => { fireEvent.click(add) })
    expect(requests[0]).toEqual({ anchor: add, multiple: true, max: 2, exclude: [{ provider: 'p', model: 'a' }], title: 'Add models to compare' })
    expect(document.querySelectorAll('[data-model-compare-chip]')).toHaveLength(1)

    // Picked models become chips in pick order; models the catalog does not list are skipped.
    await act(async () => { fireEvent.click(add) })
    expect([...document.querySelectorAll('[data-model-compare-chip]')].map(chip => chip.getAttribute('data-model-compare-chip'))).toEqual(['p/a', 'p/b', 'p/c'])
    expect(add.disabled).toBe(true)
    expect(add.textContent).toBe('Up to 3 models')

    // A chip reopens the picker for one model and swaps it in place.
    fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning effort for Beta' }), { target: { value: 'low' } })
    const gamma = screen.getByRole('button', { name: 'Change Gamma' })
    await act(async () => { fireEvent.click(gamma) })
    expect(requests[2]).toEqual({ anchor: gamma, exclude: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }], title: 'Replace Gamma' })
    expect([...document.querySelectorAll('[data-model-compare-chip]')].map(chip => chip.getAttribute('data-model-compare-chip'))).toEqual(['p/a', 'p/b', 'p/d'])

    fireEvent.change(document.querySelector('[data-model-compare-prompt]')!, { target: { value: 'go' } })
    fireEvent.click(document.querySelector('[data-model-compare-start]')!)
    await waitFor(() => { expect(calls.some(call => call.path === 'api/model-compare/start')).toBe(true) })
    expect(calls.find(call => call.path === 'api/model-compare/start')?.body['models']).toEqual([
      { provider: 'p', model: 'a' }, { provider: 'p', model: 'b', reasoningEffort: 'low' }, { provider: 'p', model: 'd' },
    ])
  })

  it('discards an open comparison', async () => {
    const { api, state, calls } = fakeApi()
    state.compare = RECORD
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(createElement(CompareView, { sessionId: 'source', deps: deps(api, []), renderLane, t }))
    await waitFor(() => { expect(document.querySelectorAll('[data-lane]')).toHaveLength(2) })
    await act(async () => { fireEvent.click(document.querySelector('[data-model-compare-discard]')!) })
    await screen.findByText('Compare models')
    expect(calls.some(call => call.path === 'api/model-compare/discard')).toBe(true)
    confirm.mockRestore()
  })
})

describe('lane column', () => {
  const stats: LaneStatsView = {
    phase: 'ended', outcome: 'completed', ttftMs: 420, latencyMs: 3100, tokensPerSecond: 38.4,
    inputTokens: 1200, outputTokens: 540, reasoningTokens: 64, cacheReadTokens: 200, costUsd: 0.0021, costUnreported: 0, requests: 1,
  }
  const owner = { lane: RECORD.lanes[1]!, index: 1, locked: false, adopting: false, onAdopt: vi.fn(), onStop: vi.fn() }

  it('shows status, statistics, the transcript, and Continue once finished', () => {
    render(createElement(LaneView, { ...owner, stats, running: false, loading: false, items: [{ kind: 'answer', key: 'a', text: 'hello', reasoning: 'thinking', streaming: false }], t }))
    expect(screen.getByRole('status').textContent).toBe('Done')
    const line = document.querySelector('[data-model-compare-stats]')!.textContent
    expect(line).toContain('First token 0.42 s')
    expect(line).toContain('Total 3.10 s')
    expect(line).toContain('1.2k in · 540 out')
    expect(line).toContain('64 reasoning')
    expect(line).toContain('38 tok/s')
    expect(line).toContain('$0.0021')
    expect(screen.getByText('hello')).toBeDefined()
    expect(screen.getByText('Reasoning')).toBeDefined()
    fireEvent.click(screen.getByText('Continue with this answer'))
    expect(owner.onAdopt).toHaveBeenCalled()
  })

  it('offers Stop while running and reports unreported cost', () => {
    render(createElement(LaneView, { ...owner, stats: { ...stats, phase: 'running', outcome: undefined, latencyMs: undefined }, running: true, loading: false, items: [], t }))
    expect(screen.getByRole('status').textContent).toBe('Answering…')
    fireEvent.click(screen.getByText('Stop'))
    expect(owner.onStop).toHaveBeenCalled()
    cleanup()
    const { costUsd: _cost, ...noCost } = stats
    render(createElement(LaneView, { ...owner, stats: noCost, running: false, loading: false, items: [], t }))
    expect(document.querySelector('[data-model-compare-stats]')!.textContent).toContain('cost not reported')
  })

  it('maps statistics to a status', () => {
    expect(laneStatus(undefined, false)).toBe('waiting')
    expect(laneStatus(undefined, true)).toBe('running')
    expect(laneStatus({ ...stats, phase: 'ended', outcome: 'error' }, false)).toBe('error')
  })
})

describe('transcript fold', () => {
  const event = (type: string, seq: number, data: unknown): WindowEntry => ({ type: 'event', event: { type, seq, data } })
  const live = (seq: number, attemptId: string, chunk: unknown): WindowEntry => ({ type: 'transient', event: { type: 'assistant/live-chunk', seq, data: { attemptId, turn: 2, step: 1, chunk } } })

  it('skips the inherited prefix and the comparison prompt, streams, and pairs tool results', () => {
    const items = foldTranscript([
      event('user/message', 0, { content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } }),
      event('assistant/message', 1, { message: { content: [{ type: 'text', text: 'old answer' }] } }),
      event('session/end-seed', 2, { inherited: true }),
      event('user/message', 3, { content: [{ type: 'text', text: 'compare me' }], source: { kind: 'user' } }),
      event('tool/call', 4, { callId: 'c1', name: 'write', arguments: '{}' }),
      event('tool/result', 5, { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'Tools are turned off' }] } }),
      live(6, 'a1', { type: 'reasoning-delta', index: 0, text: 'hmm' }),
      live(7, 'a1', { type: 'text-delta', index: 1, text: 'Hel' }),
      live(8, 'a1', { type: 'text-delta', index: 1, text: 'lo' }),
    ])
    expect(items).toEqual([
      { kind: 'tool', key: 'e4', name: 'write', error: 'Tools are turned off', done: true },
      { kind: 'answer', key: 'live-a1', text: 'Hello', reasoning: 'hmm', streaming: true },
    ])
    const settled = foldTranscript([
      event('session/end-seed', 2, {}),
      event('user/message', 3, { content: [{ type: 'text', text: 'compare me' }], source: { kind: 'user' } }),
      event('assistant/message', 9, { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Hello' }] } }),
      event('user/message', 10, { content: [{ type: 'text', text: 'follow up' }], source: { kind: 'user' } }),
      event('turn/end', 11, { reason: { kind: 'error', error: { message: 'rate limited' } } }),
    ])
    expect(settled).toEqual([
      { kind: 'answer', key: 'e9', text: 'Hello', reasoning: 'hmm', streaming: false },
      { kind: 'user', key: 'e10', text: 'follow up' },
      { kind: 'error', key: 'e11', text: 'rate limited' },
    ])
  })
})

describe('helpers', () => {
  it('formats numbers', () => {
    expect([seconds(420), seconds(31_400), seconds(250_000)]).toEqual(['0.42', '31.4', '250'])
    expect([tokens(940), tokens(1234), tokens(35_400), tokens(1_400_000)]).toEqual(['940', '1.2k', '35k', '1.4M'])
    expect([usd(0), usd(0.0021), usd(0.0134), usd(1.239)]).toEqual(['$0', '$0.0021', '$0.013', '$1.24'])
  })

  it('reads the model switcher preferences without writing them', () => {
    const raw = JSON.stringify({ favorites: ['p\u0000c', 'bad'], recents: ['p\u0000a', 3] })
    expect(parseSwitcherPrefs(raw)).toEqual({ favorites: [{ provider: 'p', model: 'c' }], recents: [{ provider: 'p', model: 'a' }] })
    expect(parseSwitcherPrefs('{')).toEqual({ favorites: [], recents: [] })
    expect(readSwitcherPrefs({ getItem: key => key === SWITCHER_PREFS_KEY ? raw : null }).favorites).toHaveLength(1)
    expect(readSwitcherPrefs({ getItem: () => { throw new Error('denied') } })).toEqual({ favorites: [], recents: [] })
  })

  it('lists favorites, recents, then the rest, filtered by every term', () => {
    const rows = catalogRows(STATE.catalog.groups)
    const sections = listRows(rows, { favorites: [{ provider: 'p', model: 'c' }], recents: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'c' }] }, '')
    expect(sections.map(section => [section.section, section.rows.map(row => row.model)])).toEqual([['favorites', ['c']], ['recents', ['a']], ['all', ['b', 'd']]])
    expect(listRows(rows, { favorites: [], recents: [] }, 'provider del').flatMap(section => section.rows.map(row => row.model))).toEqual(['d'])
  })

  it('has a complete Chinese dictionary', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
