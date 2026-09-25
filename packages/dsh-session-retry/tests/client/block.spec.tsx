// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CLASS, formatRemaining, RetryBlock, useRetryClock } from '../../src/client/RetryBlock.tsx'
import type { RetryBlockProps } from '../../src/client/RetryBlock.tsx'
import { en, zh } from '../../src/client/locales.ts'
import type { SessionRetryKey } from '../../src/client/locales.ts'
import { RETRY_BLOCK_CSS } from '../../src/client/styles.ts'
import type { SessionRetryView } from '../../src/types.ts'

// The dsh Web shell provides the primitives at runtime; tests use plain stand-ins.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    Button: ({ children, variant: _variant, size: _size, ...rest }: Record<string, unknown>) =>
      react.createElement('button', { type: 'button', ...rest }, children as never),
    Tooltip: ({ children }: { children: unknown }) => children,
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function translator(dict: Record<SessionRetryKey, string>): Translate<SessionRetryKey> {
  return (key, params = {}) => dict[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
const t = translator(en)

const HOUR = 3_600_000
const base: SessionRetryView = {
  status: 'pending',
  failedAttempt: 12,
  maxAttempts: 25,
  failedAt: 0,
  slots: [{ attempt: 13, at: 2 * HOUR }, { attempt: 14, at: 10 * HOUR }],
  giveUpAt: 20 * HOUR,
  conditionId: 'example:payments-api',
  reason: 'the payments API was unreachable',
  waitsForReadiness: false,
}

function renderBlock(overrides: Partial<RetryBlockProps> = {}) {
  const props: RetryBlockProps = {
    view: base,
    now: 0,
    t,
    onRetryNow: vi.fn(() => Promise.resolve({ ok: true as const })),
    onStop: vi.fn(() => Promise.resolve({ ok: true as const })),
    formatDate: at => `DATE(${at})`,
    ...overrides,
  }
  return { props, ...render(createElement(RetryBlock, props)) }
}

describe('retry block', () => {
  it('shows the attempt, the budget, and the time to the next slot', () => {
    renderBlock()
    expect(screen.getByRole('status').textContent).toContain('Retrying 13/25 · next in 2 h')
    expect(screen.getByText('Retry now')).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()
  })

  it('carries the exact next-retry date and the reason for the hover tooltip', () => {
    renderBlock()
    const text = screen.getByText(/Retrying 13\/25/)
    expect(text.getAttribute('data-retry-tooltip')).toBe(`Next retry: DATE(${2 * HOUR}) · Reason: the payments API was unreachable`)
  })

  it('counts skipped slots and says what it is waiting for', () => {
    renderBlock({ view: { ...base, waitsForReadiness: true }, now: 3 * HOUR })
    expect(screen.getByRole('status').textContent).toContain(
      'Retrying 14/25 · waiting: the payments API was unreachable · next in 7 h',
    )
  })

  it('localizes built-in reasons and the whole line', () => {
    const zhT = translator(zh)
    renderBlock({ t: zhT, view: { ...base, conditionId: 'builtin:transport', reason: 'x' } })
    const text = screen.getByText(/正在重试/)
    expect(text.textContent).toBe('正在重试 13/25 · 2 小时后重试')
    expect(text.getAttribute('data-retry-tooltip')).toContain('原因：与模型服务的连接失败')
  })

  it('shows the exhausted state with only Retry now and a still dot', () => {
    renderBlock({ view: { ...base, status: 'exhausted', failedAttempt: 25, slots: [] } })
    expect(screen.getByRole('status').textContent).toContain('Gave up after 25 attempts')
    expect(screen.getByText('Retry now')).toBeTruthy()
    expect(screen.queryByText('Stop')).toBeNull()
    expect(document.querySelector(`.${CLASS.dot}`)?.classList.contains(CLASS.dotStill)).toBe(true)
  })

  it('gives up by time once the last slot passed unsent', () => {
    renderBlock({ now: 21 * HOUR })
    expect(screen.getByRole('status').textContent).toContain('Gave up after 25 attempts')
  })

  it('shows a running retry without actions', () => {
    renderBlock({ view: { ...base, status: 'running', sentAttempt: 13 } })
    expect(screen.getByRole('status').textContent).toContain('Retry 13/25 in progress')
    expect(screen.queryByText('Retry now')).toBeNull()
    expect(screen.queryByText('Stop')).toBeNull()
  })

  it('renders nothing while nothing is pending', () => {
    const { container } = renderBlock({ view: null })
    expect(container.innerHTML).toBe('')
  })

  it('runs the actions and reports a refused request in place', async () => {
    const onStop = vi.fn(() => Promise.resolve({ ok: false as const }))
    const { props } = renderBlock({ onStop })
    await act(async () => { fireEvent.click(screen.getByText('Retry now')) })
    expect(props.onRetryNow).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByText('Stop')) })
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe('The session did not accept the request')
  })

  it('pulses the dot slowly and stops the animation for reduced motion', () => {
    renderBlock()
    expect(document.querySelector(`.${CLASS.dot}`)?.classList.contains(CLASS.dotStill)).toBe(false)
    expect(RETRY_BLOCK_CSS).toMatch(/animation: dsh-session-retry-pulse 2\.4s ease-in-out infinite/)
    expect(RETRY_BLOCK_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.dsh-session-retry-dot \{ animation: none; \}/)
    expect(RETRY_BLOCK_CSS).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i)
  })

  it('formats remaining time by magnitude', () => {
    expect(formatRemaining(400, t)).toBe('1 s')
    expect(formatRemaining(45_000, t)).toBe('45 s')
    expect(formatRemaining(10 * 60_000, t)).toBe('10 min')
    expect(formatRemaining(30 * HOUR, t)).toBe('30 h')
    expect(formatRemaining(3.4 * 24 * HOUR, t)).toBe('3 d')
  })
})

describe('live countdown', () => {
  function Clocked({ view }: { view: SessionRetryView }) {
    const now = useRetryClock(view)
    return createElement(RetryBlock, {
      view, now, t, onRetryNow: () => Promise.resolve({ ok: true }), onStop: () => Promise.resolve({ ok: true }),
    })
  }

  it('ticks while waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(0)
    render(createElement(Clocked, { view: { ...base, slots: [{ attempt: 13, at: 90_000 }], giveUpAt: 10 * HOUR } }))
    expect(screen.getByRole('status').textContent).toContain('next in 2 min')
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      }
    }
    await advance(60_000)
    expect(screen.getByRole('status').textContent).toContain('next in 30 s')
    await advance(20_000)
    expect(screen.getByRole('status').textContent).toContain('next in 10 s')
  })
})
