import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { phaseAt } from '../src/decision.ts'
import type { RetryCondition, SessionRetryView } from '../src/types.ts'
import { flush, mountHarness, service } from './harness.ts'
import type { Harness } from './harness.ts'

const harnesses: Harness[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  service.online = true
})

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map(harness => harness.dispose()))
  vi.useRealTimers()
})

async function mount(...args: Parameters<typeof mountHarness>): Promise<Harness> {
  const harness = await mountHarness(...args)
  harnesses.push(harness)
  return harness
}

function view(harness: Harness): SessionRetryView | null | undefined {
  return harness.ctx.sessionRetry.view(harness.agent.id)
}

/** Advance to the next slot of the current view and let the continuation run. */
async function advanceToNextSlot(harness: Harness): Promise<void> {
  const current = view(harness)
  const phase = phaseAt(current ?? null, Date.now())
  if (phase.kind !== 'waiting' || phase.next === undefined) throw new Error(`no next slot (${phase.kind})`)
  await vi.advanceTimersByTimeAsync(phase.next.at - Date.now())
  await flush()
  await harness.agent.whenIdle()
  await flush()
}

describe('automatic retries through the real agent loop', () => {
  it('parks a transport failure, retries at the first slot with a logged continuation, and clears on success', async () => {
    const harness = await mount()
    harness.adapter.script.push({ kind: 'fail', code: 'TRANSPORT', message: 'socket hang up' })
    await harness.say('Summarize the report')
    expect(harness.agent.status).toBe('idle')

    const pending = view(harness)
    expect(pending).toMatchObject({
      status: 'pending',
      failedAttempt: 1,
      maxAttempts: 25,
      conditionId: 'builtin:transport',
      reason: 'the connection to the model provider failed',
      waitsForReadiness: false,
    })
    expect(pending?.slots).toHaveLength(24)
    expect(pending?.slots[0]?.attempt).toBe(2)
    // Attempt 2 follows the failure by 1 s ± 10%.
    const firstWait = pending!.slots[0]!.at - pending!.failedAt
    expect(firstWait).toBeGreaterThanOrEqual(900)
    expect(firstWait).toBeLessThanOrEqual(1_100)

    harness.adapter.script.push({ kind: 'text', text: 'Here is the summary.' })
    await advanceToNextSlot(harness)

    const messages = harness.userMessages()
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      kind: 'session-retry',
      text: '(Automatic retry 2/25: the connection to the model provider failed. Continue the previous request.)',
      source: {
        kind: 'session-retry',
        attempt: 2,
        maxAttempts: 25,
        conditionId: 'builtin:transport',
        reason: 'the connection to the model provider failed',
        trigger: 'schedule',
      },
    })
    // The continuation reached the model as an ordinary user message.
    const lastRequest = JSON.stringify(harness.adapter.requests.at(-1))
    expect(lastRequest).toContain('Automatic retry 2/25')
    expect(view(harness)).toBeNull()
  })

  it('counts a failed retry and schedules the next attempt from it', async () => {
    const harness = await mount()
    harness.adapter.script.push(
      { kind: 'fail', code: 'SERVER', status: 503 },
      { kind: 'fail', code: 'SERVER', status: 503 },
    )
    await harness.say('go')
    expect(view(harness)?.reason).toBe('the model provider returned a server error (503)')
    await advanceToNextSlot(harness)
    const afterSecond = view(harness)
    expect(afterSecond).toMatchObject({ status: 'pending', failedAttempt: 2, conditionId: 'builtin:server-error' })
    expect(afterSecond?.slots[0]?.attempt).toBe(3)
    const wait = afterSecond!.slots[0]!.at - afterSecond!.failedAt
    expect(wait).toBeGreaterThanOrEqual(16_000 * 0.9)
    expect(wait).toBeLessThanOrEqual(16_000 * 1.1)
  })

  it('never retries a failure no condition matches', async () => {
    const harness = await mount()
    harness.adapter.script.push({ kind: 'fail', code: 'INVALID_REQUEST', status: 400 })
    await harness.say('go')
    expect(view(harness)).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(harness.userMessages()).toHaveLength(1)
  })

  it('cancels the pending retry when a person writes', async () => {
    const harness = await mount()
    harness.adapter.script.push({ kind: 'fail', code: 'RATE_LIMIT', status: 429 }, { kind: 'text', text: 'ok' })
    await harness.say('first')
    expect(view(harness)?.conditionId).toBe('builtin:rate-limit')
    await harness.say('never mind, do this instead')
    expect(view(harness)).toBeNull()
    await vi.advanceTimersByTimeAsync(3_600_000)
    await flush()
    expect(harness.userMessages().map(message => message.kind)).toEqual(['user', 'user'])
    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('stops on /retry stop and runs immediately on /retry now', async () => {
    const harness = await mount()
    harness.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' })
    await harness.say('first')
    const stop = await harness.ctx.commands.execute(harness.agent, '/retry stop', [], new AbortController().signal)
    expect(stop?.result).toEqual({ kind: 'success', text: 'Automatic retries stopped.' })
    await flush()
    expect(view(harness)).toBeNull()
    await vi.advanceTimersByTimeAsync(3_600_000)
    await flush()
    expect(harness.adapter.requests).toHaveLength(1)
    const nothing = await harness.ctx.commands.execute(harness.agent, '/retry now', [], new AbortController().signal)
    expect(nothing?.result).toEqual({ kind: 'error', text: 'Nothing to retry.' })

    harness.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'text', text: 'ok' })
    await harness.say('second')
    const pending = view(harness)
    expect(pending?.status).toBe('pending')
    const now = await harness.ctx.commands.execute(harness.agent, '/retry now', [], new AbortController().signal)
    expect(now?.result).toEqual({ kind: 'success', text: 'Retry 2/25 started.' })
    await harness.agent.whenIdle()
    await flush()
    expect(harness.userMessages().at(-1)?.source).toMatchObject({ kind: 'session-retry', attempt: 2, trigger: 'manual' })
    expect(view(harness)).toBeNull()
  })

  it('gives up after the last allowed attempt fails and still offers a manual retry', async () => {
    const harness = await mount({ maxAttempts: 3 })
    harness.adapter.script.push(
      { kind: 'fail', code: 'TRANSPORT' },
      { kind: 'fail', code: 'TRANSPORT' },
      { kind: 'fail', code: 'TRANSPORT' },
    )
    await harness.say('go')
    await advanceToNextSlot(harness)
    await advanceToNextSlot(harness)
    const exhausted = view(harness)
    expect(exhausted).toMatchObject({ status: 'exhausted', failedAttempt: 3, maxAttempts: 3, slots: [] })
    expect(phaseAt(exhausted ?? null, Date.now()).kind).toBe('exhausted')
    await vi.advanceTimersByTimeAsync(30 * 24 * 3_600_000)
    await flush()
    expect(harness.adapter.requests).toHaveLength(3)

    harness.adapter.script.push({ kind: 'text', text: 'finally' })
    expect(harness.ctx.sessionRetry.retryNow(harness.agent.id)).toEqual({ ok: true, attempt: 3 })
    await harness.agent.whenIdle()
    await flush()
    expect(view(harness)).toBeNull()
  })

  it('honors an overridden continuation, budget, and disabled built-in', async () => {
    const harness = await mount({
      maxAttempts: 5,
      continuation: 'Retry {attempt} of {maxAttempts} ({reason}).',
      builtins: { transport: { enabled: false } },
    })
    harness.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' })
    await harness.say('go')
    expect(view(harness)).toBeNull()
    harness.adapter.script.push({ kind: 'fail', code: 'TIMEOUT' }, { kind: 'text', text: 'ok' })
    await harness.say('again')
    expect(view(harness)?.maxAttempts).toBe(5)
    await advanceToNextSlot(harness)
    expect(harness.userMessages().at(-1)?.text).toBe('Retry 2 of 5 (the model provider stopped responding).')
  })
})

describe('third-party retry conditions', () => {
  function paymentsCondition(overrides: Partial<RetryCondition> = {}): RetryCondition {
    return {
      id: 'example:payments-api',
      matches(failure) {
        const last = failure.toolResults.filter(result => result.toolName === 'charge_card').at(-1)
        return last?.isError === true && last.errorText?.includes('Payments API is unreachable') === true
          ? { reason: 'the payments API was unreachable' }
          : undefined
      },
      ...overrides,
    }
  }

  async function failOnTool(harness: Harness): Promise<void> {
    service.online = false
    harness.adapter.script.push({ kind: 'tool', name: 'charge_card' }, { kind: 'text', text: 'The payments API is down.' })
    await harness.say('Charge the card')
  }

  it('classifies tool failures and skips due slots while the dependency is not ready', async () => {
    const readiness: boolean[] = []
    const harness = await mount({}, {
      beforePlugin: () => {},
    })
    const dispose = harness.ctx.sessionRetry.registerCondition(paymentsCondition({
      isReady: () => {
        readiness.push(service.online)
        return service.online
      },
    }))
    await failOnTool(harness)
    const pending = view(harness)
    expect(pending).toMatchObject({
      status: 'pending',
      conditionId: 'example:payments-api',
      reason: 'the payments API was unreachable',
      waitsForReadiness: true,
    })
    const requestsBefore = harness.adapter.requests.length

    // Slot 2 comes due while the API is still down: skipped, nothing logged, no model call.
    await advanceToNextSlot(harness)
    expect(readiness).toEqual([false])
    expect(harness.adapter.requests).toHaveLength(requestsBefore)
    expect(harness.userMessages()).toHaveLength(1)
    const phase = phaseAt(view(harness) ?? null, Date.now())
    expect(phase).toMatchObject({ kind: 'waiting', due: { attempt: 2 }, next: { attempt: 3 } })

    // Slot 3 comes due after the API is back: the model runs attempt 3.
    service.online = true
    harness.adapter.script.push({ kind: 'tool', name: 'charge_card' }, { kind: 'text', text: 'Charged.' })
    await advanceToNextSlot(harness)
    expect(readiness).toEqual([false, true])
    expect(harness.userMessages().at(-1)?.source).toMatchObject({
      kind: 'session-retry', attempt: 3, conditionId: 'example:payments-api', trigger: 'schedule',
    })
    expect(view(harness)).toBeNull()
    dispose()
  })

  it('runs the pending attempt as soon as the ready signal fires', async () => {
    let signal: (() => void) | undefined
    let subscriptions = 0
    let disposals = 0
    const harness = await mount()
    harness.ctx.sessionRetry.registerCondition(paymentsCondition({
      ready: (ref, fire) => {
        expect(ref.match.reason).toBe('the payments API was unreachable')
        subscriptions += 1
        signal = fire
        return () => { disposals += 1 }
      },
    }))
    await failOnTool(harness)
    await flush()
    expect(subscriptions).toBe(1)

    service.online = true
    harness.adapter.script.push({ kind: 'text', text: 'Charged.' })
    signal?.()
    await flush()
    await harness.agent.whenIdle()
    await flush()
    expect(harness.userMessages().at(-1)?.source).toMatchObject({ kind: 'session-retry', attempt: 2, trigger: 'ready' })
    expect(disposals).toBe(1)
    expect(view(harness)).toBeNull()
  })

  it('removes a condition with its disposer and orders by priority', async () => {
    const harness = await mount()
    const low = harness.ctx.sessionRetry.registerCondition({ id: 'example:low', matches: () => ({ reason: 'low' }) })
    const high = harness.ctx.sessionRetry.registerCondition({ id: 'example:high', priority: 10, matches: () => ({ reason: 'high' }) })
    expect(harness.ctx.sessionRetry.conditions().map(condition => condition.id).slice(0, 1)).toEqual(['example:high'])
    expect(() => harness.ctx.sessionRetry.registerCondition({ id: 'example:low', matches: () => undefined })).toThrow(/already registered/)
    expect(() => harness.ctx.sessionRetry.registerCondition({ id: 'Bad Id', matches: () => undefined })).toThrow(/invalid condition id/)

    harness.adapter.script.push({ kind: 'text', text: 'fine' })
    await harness.say('go')
    expect(view(harness)?.reason).toBe('high')
    high()
    expect(view(harness)?.reason).toBe('low')
    low()
    expect(view(harness)).toBeNull()
  })

  it('unregisters a plugin\'s conditions when that plugin unloads', async () => {
    const harness = await mount()
    const fiber = harness.ctx.plugin({
      name: 'example-conditions',
      inject: ['sessionRetry'],
      apply: (ctx) => {
        ctx.sessionRetry.registerCondition({ id: 'example:plugin', matches: () => ({ reason: 'from plugin' }) })
      },
    })
    await fiber
    expect(harness.ctx.sessionRetry.conditions().some(condition => condition.id === 'example:plugin')).toBe(true)
    await fiber.dispose()
    expect(harness.ctx.sessionRetry.conditions().some(condition => condition.id === 'example:plugin')).toBe(false)
  })
})
