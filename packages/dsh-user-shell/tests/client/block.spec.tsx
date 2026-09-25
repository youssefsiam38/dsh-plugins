// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { parseShellLine } from '../../src/client/index.ts'
import { ShellBlock, ShellModeIndicator } from '../../src/client/ShellBlock.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { UserShellKey } from '../../src/client/locales.ts'
import { UserShellStore } from '../../src/client/store.ts'
import { recordText } from '../../src/record.ts'

// The dsh Web shell provides the primitives at runtime; tests use plain stand-ins.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, variant: _variant, size: _size, ...rest }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...rest }, children as never),
  }
})

afterEach(cleanup)

function translator(dict: Record<UserShellKey, string>): Translate<UserShellKey> {
  return (key, params = {}) => dict[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
const t = translator(en)

function mockFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const body = url.endsWith('/run') ? { commandId: 'c1' } : { ok: true }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
  return { calls, fetcher }
}

const view = { commandId: 'c1', sessionId: 's1', command: 'sudo apt update', mode: 'context' as const, startedAt: 0, output: 'Reading…\n', outputTruncated: false }

describe('ShellBlock', () => {
  it('shows live output, cancels, and answers the password prompt from the owning tab', async () => {
    const { calls, fetcher } = mockFetch()
    const store = new UserShellStore(fetcher)
    await store.startRun('s1', 'sudo apt update', 'context')
    act(() => { store.apply({ type: 'start', run: view }) })
    render(createElement(ShellBlock, { node: { commandId: 'c1', args: ' sudo apt update', outcome: null }, mode: 'context', store, t }))
    expect(screen.getByText('sudo apt update')).toBeTruthy()
    expect(screen.getByText('Running…')).toBeTruthy()
    expect(screen.getByText('Reading…', { exact: false })).toBeTruthy()

    act(() => { store.apply({ type: 'askpass', commandId: 'c1', askpass: { requestId: '77', prompt: '[sudo] password for me:' } }) })
    const field = screen.getByLabelText('Password') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: 's3cret' } })
    field.value = 's3cret'
    await act(async () => { fireEvent.submit(field.closest('form')!) })
    expect(field.value).toBe('')
    expect(calls.at(-1)).toEqual({ url: 'api/user-shell/askpass', body: { commandId: 'c1', requestId: '77', owner: store.owner, password: 's3cret' } })

    act(() => { store.apply({ type: 'askpass-closed', commandId: 'c1', requestId: '77' }) })
    expect(screen.queryByLabelText('Password')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('Cancel')) })
    expect(calls.at(-1)).toEqual({ url: 'api/user-shell/cancel', body: { commandId: 'c1' } })
  })

  it('another tab sees the prompt but no field', () => {
    const store = new UserShellStore(mockFetch().fetcher)
    act(() => {
      store.apply({ type: 'start', run: view })
      store.apply({ type: 'askpass', commandId: 'c1', askpass: { requestId: '1', prompt: '' } })
    })
    render(createElement(ShellBlock, { node: { commandId: 'c1', args: null, outcome: null }, mode: 'context', store, t }))
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByText(en['askpass.otherTab'])).toBeTruthy()
  })

  it('renders the record: exit code and duration even with empty output', () => {
    const store = new UserShellStore(mockFetch().fetcher)
    const text = recordText({ output: '', status: { kind: 'exited', exitCode: 0 }, durationMs: 20 })
    const { container } = render(createElement(ShellBlock, { node: { commandId: 'c9', args: ' true', outcome: { kind: 'success', text } }, mode: 'quiet', store, t }))
    expect(screen.getByText('Exit 0 · 0.02 s')).toBeTruthy()
    expect(screen.getByText('No output')).toBeTruthy()
    expect(screen.getByText(en['context.skipped'])).toBeTruthy()
    expect(container.querySelector('[data-mode="quiet"]')?.textContent).toContain('!!')
  })

  it('renders a failed run with its full-output path', () => {
    const store = new UserShellStore(mockFetch().fetcher)
    const text = recordText({ output: 'boom', status: { kind: 'exited', exitCode: 2 }, durationMs: 1500, fullOutput: '/tmp/out.txt' })
    const { container } = render(createElement(ShellBlock, { node: { commandId: 'c9', args: ' make', outcome: { kind: 'error', text } }, mode: 'context', store, t }))
    expect(container.querySelector('[data-state="failed"]')).toBeTruthy()
    expect(screen.getByText('Exit 2 · 1.50 s')).toBeTruthy()
    expect(screen.getByText(`${en['context.added']} · Full output: /tmp/out.txt`)).toBeTruthy()
  })
})

describe('composer', () => {
  it('parses ! and !!', () => {
    expect(parseShellLine('ls -la ')).toEqual({ mode: 'context', command: 'ls -la' })
    expect(parseShellLine('! git status')).toEqual({ mode: 'quiet', command: 'git status' })
    expect(parseShellLine('')).toEqual({ mode: 'context', command: '' })
  })

  it('shows the mode chip', () => {
    const { container, rerender } = render(createElement(ShellModeIndicator, { draft: '!ls', supported: true, t }))
    expect(container.querySelector('[data-user-shell-mode="context"]')).toBeTruthy()
    rerender(createElement(ShellModeIndicator, { draft: '!!ls', supported: true, t }))
    expect(container.querySelector('[data-user-shell-mode="quiet"]')).toBeTruthy()
    rerender(createElement(ShellModeIndicator, { draft: '!ls', supported: false, t }))
    expect(container.textContent).toContain('/sh <command>')
    rerender(createElement(ShellModeIndicator, { draft: 'hello', supported: true, t }))
    expect(container.textContent).toBe('')
  })
})

describe('locales', () => {
  it('zh covers every key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('user-shell chat node', () => {
  it('folds the sh / shq command pair into one session-located node', async () => {
    const { userShellDefinition } = await import('../../src/client/node.ts')
    const run = { type: 'command/run', seq: 7, time: 1, data: { commandId: 'c1', name: 'shq', args: ' ls', source: { kind: 'user' } } }
    const done = { type: 'command/done', seq: 9, time: 2, data: { commandId: 'c1', kind: 'error', text: '[exit 2 · 0.10 s]' } }
    const other = { type: 'command/run', seq: 3, time: 1, data: { commandId: 'c0', name: 'plan', source: { kind: 'user' } } }
    const definition = userShellDefinition as unknown as {
      match(event: unknown): unknown
      start(context: unknown, match: unknown): Record<string, unknown>
      update(context: unknown, match: unknown): Record<string, unknown>
      buildViewNode(context: unknown): Record<string, unknown> | null
    }
    expect(definition.match(other)).toBeNull()
    expect(definition.match(run)).toEqual({ id: 'c1', role: 'start' })
    expect(definition.match(done)).toEqual({ id: 'c1', role: 'update' })
    const started = definition.start({}, { event: run })
    const updated = definition.update({ state: started }, { event: done })
    const node = definition.buildViewNode({ key: 'k', id: 'c1', state: updated })
    expect(node).toMatchObject({
      kind: 'user-shell',
      anchorSeq: 7,
      location: { kind: 'session' },
      data: { commandId: 'c1', mode: 'quiet', args: ' ls', outcome: { kind: 'error', text: '[exit 2 · 0.10 s]' } },
    })
    expect(definition.buildViewNode({ key: 'k', id: 'c1', state: undefined })).toBeNull()
  })
})
