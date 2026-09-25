// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { ReviewPanel } from '../../src/client/ReviewPanel.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { HunkReviewKey } from '../../src/client/locales.ts'
import { hunkReviewDefinition, parseReviewAddress, reviewAddress } from '../../src/client/node.ts'
import { ReviewStore } from '../../src/client/store.ts'
import type { ReviewTarget, TurnReview } from '../../src/types.ts'

// The dsh Web shell provides the primitives at runtime; tests use plain stand-ins.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, variant: _variant, size: _size, ...rest }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...rest }, children as never),
  }
})

afterEach(cleanup)

function translator(dict: Record<HunkReviewKey, string>): Translate<HunkReviewKey> {
  return (key, params = {}) => dict[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
const t = translator(en)

const REVIEW: TurnReview = {
  turn: 2,
  seq: 40,
  total: 2,
  files: [
    { index: 0, path: 'src/a.ts', display: 'src/a.ts', added: 2, deleted: 1, before: true, after: true, coarse: false, hunks: [
      { hunk: 0, oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+more'], status: 'pending' },
      { hunk: 1, oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ['-x', '+y'], status: 'conflict', drift: ['-y', '+z'] },
    ] },
    { index: 1, path: 'b.txt', display: 'b.txt', added: 1, deleted: 0, before: false, after: true, coarse: false, hunks: [
      { hunk: 0, oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'], status: 'kept' },
    ] },
  ],
}

function renderPanel(overrides: Partial<Parameters<typeof ReviewPanel>[0]> = {}) {
  const onKeep = vi.fn<(target: ReviewTarget) => void>()
  const onRevert = vi.fn<(target: ReviewTarget) => void>()
  const onRefresh = vi.fn()
  const view = render(createElement(ReviewPanel, { state: REVIEW, notice: undefined, busy: false, onKeep, onRevert, onRefresh, t, ...overrides }))
  return { ...view, onKeep, onRevert, onRefresh }
}

describe('ReviewPanel', () => {
  it('shows files, hunks with line numbers, statuses, and the conflict drift', () => {
    const { container } = renderPanel()
    expect(screen.getByText('Turn 2')).toBeTruthy()
    expect(screen.getByText('2 files · 1 to review')).toBeTruthy()
    expect(container.querySelectorAll('[data-hunk-review-hunk]')).toHaveLength(3)
    const first = container.querySelector('[data-hunk-review-hunk="0:0"]')!
    expect(first.querySelectorAll('[data-sign="add"]')).toHaveLength(2)
    expect(first.querySelector('[data-sign="del"]')?.textContent).toBe('2-old')
    const conflict = container.querySelector('[data-hunk-review-hunk="0:1"]')!
    expect(conflict.getAttribute('data-status')).toBe('conflict')
    expect(conflict.querySelector('[data-hunk-review-conflict]')?.textContent).toContain('z')
    expect(screen.getByText(en['file.createdNote'])).toBeTruthy()
    expect(screen.getByText('Kept')).toBeTruthy()
  })

  it('keeps, reverts, and re-diffs through buttons', () => {
    const { container, onKeep, onRevert, onRefresh } = renderPanel()
    const first = container.querySelector('[data-hunk-review-hunk="0:0"]')!
    fireEvent.click(first.querySelector('[data-hunk-review-action="keep"]')!)
    expect(onKeep).toHaveBeenLastCalledWith({ scope: 'hunk', index: 0, hunk: 0 })
    fireEvent.click(first.querySelector('[data-hunk-review-action="revert"]')!)
    expect(onRevert).toHaveBeenLastCalledWith({ scope: 'hunk', index: 0, hunk: 0 })
    fireEvent.click(container.querySelector('[data-hunk-review-action="revert-file"]')!)
    expect(onRevert).toHaveBeenLastCalledWith({ scope: 'file', index: 0 })
    fireEvent.click(container.querySelector('[data-hunk-review-action="keep-all"]')!)
    expect(onKeep).toHaveBeenLastCalledWith({ scope: 'all' })
    fireEvent.click(container.querySelector('[data-hunk-review-hunk="0:1"] [data-hunk-review-action="refresh"]')!)
    expect(onRefresh).toHaveBeenCalled()
    // A kept hunk can still be reverted but not kept again.
    const kept = container.querySelector('[data-hunk-review-hunk="1:0"]')!
    expect(kept.querySelector('[data-hunk-review-action="keep"]')).toBeNull()
    expect(kept.querySelector('[data-hunk-review-action="revert"]')).toBeTruthy()
  })

  it('j / k move between hunks, y keeps, n reverts', () => {
    const { container, onKeep, onRevert } = renderPanel()
    const root = container.querySelector('[data-hunk-review]')!
    fireEvent.keyDown(root, { key: 'j' })
    expect(container.querySelector('[data-focused]')?.getAttribute('data-hunk-review-hunk')).toBe('0:0')
    fireEvent.keyDown(root, { key: 'y' })
    expect(onKeep).toHaveBeenLastCalledWith({ scope: 'hunk', index: 0, hunk: 0 })
    expect(container.querySelector('[data-focused]')?.getAttribute('data-hunk-review-hunk')).toBe('0:1')
    // A conflict can be neither kept nor reverted.
    fireEvent.keyDown(root, { key: 'n' })
    expect(onRevert).not.toHaveBeenCalled()
    fireEvent.keyDown(root, { key: 'j' })
    fireEvent.keyDown(root, { key: 'n' })
    expect(onRevert).toHaveBeenLastCalledWith({ scope: 'hunk', index: 1, hunk: 0 })
    fireEvent.keyDown(root, { key: 'k' })
    fireEvent.keyDown(root, { key: 'k' })
    expect(container.querySelector('[data-focused]')?.getAttribute('data-hunk-review-hunk')).toBe('0:0')
  })

  it('shows loading, missing, error, and notices', () => {
    const { rerender } = renderPanel({ state: 'loading' })
    expect(screen.getByText(en['state.loading'])).toBeTruthy()
    const base = { busy: false, onKeep: () => {}, onRevert: () => {}, onRefresh: () => {}, t }
    rerender(createElement(ReviewPanel, { ...base, state: 'missing', notice: undefined }))
    expect(screen.getByText(en['state.missing'])).toBeTruthy()
    rerender(createElement(ReviewPanel, { ...base, state: { error: 'boom' }, notice: undefined }))
    expect(screen.getByText('The changes could not be loaded: boom')).toBeTruthy()
    rerender(createElement(ReviewPanel, { ...base, state: REVIEW, notice: { kind: 'reverted', notified: true, results: [
      { index: 0, hunk: 0, outcome: 'reverted' }, { index: 0, hunk: 1, outcome: 'conflict' },
    ] } }))
    expect(screen.getByRole('status').textContent).toBe(`${en['result.revertedOne']} 1 hunks changed since the turn and were not reverted.`)
  })
})

describe('ReviewStore', () => {
  it('loads summaries once, reviews, and posts keep and revert', async () => {
    const calls: { url: string; body?: unknown }[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown } })
      if (url.startsWith('api/hunk-review/summary')) return Promise.resolve(Response.json({ turn: 2, total: 2, added: 3, deleted: 1 }))
      if (url.startsWith('api/hunk-review/review')) return Promise.resolve(Response.json(REVIEW))
      if (url === 'api/hunk-review/revert') return Promise.resolve(Response.json({ results: [{ index: 0, hunk: 0, outcome: 'reverted' }], notified: true, review: REVIEW }))
      return Promise.resolve(Response.json({ error: 'nope' }, { status: 409 }))
    })
    const store = new ReviewStore(fetcher)
    await store.loadSummary('s 1', 40)
    await store.loadSummary('s 1', 40)
    expect(calls.filter(call => call.url.includes('summary'))).toHaveLength(1)
    expect(calls[0]!.url).toBe('api/hunk-review/summary?sessionId=s+1&seq=40')
    expect(store.summary('s 1', 40)).toMatchObject({ total: 2 })
    await store.loadReview('s 1', 40)
    expect(store.review('s 1', 40)).toEqual(REVIEW)
    await act(async () => { await store.revert('s 1', 40, { scope: 'all' }) })
    expect(calls.at(-1)).toEqual({ url: 'api/hunk-review/revert', body: { sessionId: 's 1', seq: 40, target: { scope: 'all' } } })
    expect(store.notice('s 1', 40)).toMatchObject({ kind: 'reverted', notified: true })
    await store.keep('s 1', 40, { scope: 'all' })
    expect(store.notice('s 1', 40)).toEqual({ kind: 'failed', message: 'nope' })
  })
})

describe('turn data and addresses', () => {
  it('publishes the latest workspace/changes sequence of a turn', () => {
    const definition = hunkReviewDefinition as unknown as {
      match(event: unknown): unknown
      start(context: unknown, match: unknown): Record<string, unknown>
      update(context: unknown, match: unknown): Record<string, unknown>
      buildLocationData(context: unknown, scope: string, previous: unknown): unknown
    }
    const start = { type: 'turn/start', seq: 3, time: 0, data: { turn: 2 } }
    const changes = { type: 'workspace/changes', seq: 9, time: 0, data: { turn: 2 } }
    expect(definition.match({ type: 'tool/call', seq: 4, time: 0, data: {} })).toBeNull()
    expect(definition.match(start)).toEqual({ id: '2', role: 'start' })
    expect(definition.match(changes)).toEqual({ id: '2', role: 'update' })
    const state = definition.update({ state: definition.start({}, { event: start }) }, { event: changes })
    expect(definition.buildLocationData({ state }, 'step', null)).toBeNull()
    const data = definition.buildLocationData({ state }, 'turn', null)
    expect(data).toEqual({ kind: 'turn', turn: 2, key: 'hunk-review', value: { seq: 9, turn: 2 } })
    expect(definition.buildLocationData({ state }, 'turn', data)).toBe(data)
    expect(definition.buildLocationData({ state: definition.start({}, { event: start }) }, 'turn', null)).toBeNull()
  })

  it('round-trips review addresses', () => {
    const address = reviewAddress({ sessionId: 'a/b c', seq: 12, turn: 3 })
    expect(address).toBe('dsh-resource://hunk-review/session/a%2Fb%20c/12/3')
    expect(parseReviewAddress(address)).toEqual({ sessionId: 'a/b c', seq: 12, turn: 3 })
    expect(parseReviewAddress('dsh-resource://hunk-review/session/x/1/0')).toBeUndefined()
    expect(parseReviewAddress('dsh-resource://file/x')).toBeUndefined()
  })
})

describe('locales', () => {
  it('zh covers every key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
