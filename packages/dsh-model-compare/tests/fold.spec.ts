/** Pure folds: lane statistics and the fork boundary. */

import { describe, expect, it } from 'vitest'
import { forkBoundary } from '../src/fork.ts'
import { foldStats, statsView } from '../src/stats.ts'
import type { StatsEvent } from '../src/stats.ts'
import { labelModels, parseModels } from '../src/index.ts'
import { catalogGroups } from '../src/index.ts'
import { CATALOG } from './harness.ts'

let seq = 0
function event(type: string, time: number, data: unknown): StatsEvent {
  return { type, seq: seq++, time, data }
}

function answer(turn: number, time: number, firstToken: number, usage: Record<string, number> | undefined, model = 'm') {
  return event('assistant/message', time, {
    turn,
    step: 1,
    message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model } },
    stream: [{ type: 'text-chunks', time0: firstToken, index: 0, dt: [], texts: ['hi'] }],
    ...usage === undefined ? {} : { usage },
  })
}

describe('lane statistics', () => {
  it('measures the first own turn and ignores the inherited prefix and later turns', () => {
    seq = 0
    const events = [
      event('turn/start', 0, { turn: 1 }),
      answer(1, 5, 2, { inputTokens: 999, outputTokens: 999 }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 1000, { turn: 2 }),
      event('assistant/attempt', 1100, { turn: 2, step: 1, stream: [{ type: 'chunk', time: 1100, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } } }] }),
      answer(2, 2000, 1200, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, reasoningTokens: 8, costUsd: 0.01 }),
      event('turn/end', 2100, { turn: 2, reason: { kind: 'completed' } }),
      event('turn/start', 3000, { turn: 3 }),
      answer(3, 3100, 3050, { inputTokens: 5, outputTokens: 5 }),
    ]
    const view = statsView(foldStats(events, 3))
    expect(view).toMatchObject({
      phase: 'ended',
      outcome: 'completed',
      ttftMs: 200,
      latencyMs: 1100,
      inputTokens: 130,
      outputTokens: 40,
      reasoningTokens: 8,
      cacheReadTokens: 20,
      costUnreported: 1,
      requests: 2,
      provider: 'p',
      model: 'm',
    })
    expect(view.costUsd).toBeCloseTo(0.01)
    expect(view.tokensPerSecond).toBeCloseTo(40 / 0.8)
  })

  it('reports waiting, running, and errors', () => {
    seq = 0
    expect(statsView(foldStats([])).phase).toBe('waiting')
    const running = foldStats([event('turn/start', 10, { turn: 1 })])
    expect(statsView(running)).toMatchObject({ phase: 'running', inputTokens: 0 })
    const failed = statsView(foldStats([
      event('turn/start', 10, { turn: 1 }),
      event('turn/end', 30, { turn: 1, reason: { kind: 'error', error: { message: 'rate limited', code: 'x' } } }),
    ]))
    expect(failed).toMatchObject({ phase: 'ended', outcome: 'error', errorMessage: 'rate limited', latencyMs: 20 })
    expect(failed.costUsd).toBeUndefined()
    expect(statsView(foldStats([event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1, reason: { kind: 'odd' } })])).outcome).toBe('other')
  })

  it('reads usage from the stream when the message carries none', () => {
    seq = 0
    const view = statsView(foldStats([
      event('turn/start', 0, { turn: 1 }),
      event('assistant/message', 10, { turn: 1, step: 1, message: { source: {} }, stream: [{ type: 'chunk', time: 5, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } }] }),
    ]))
    expect(view).toMatchObject({ inputTokens: 7, outputTokens: 3, requests: 1 })
  })
})

describe('fork boundary', () => {
  const at = (types: string[]) => types.map((type, index) => ({ type, seq: index }))

  it('cuts after the last completed turn and its standalone trailers', () => {
    expect(forkBoundary(at(['turn/start', 'turn/end', 'session/title', 'model/selection']))).toBe(3)
    expect(forkBoundary(at(['turn/start', 'turn/end', 'session/title', 'user/message', 'turn/start']))).toBe(2)
    expect(forkBoundary(at(['turn/start', 'turn/end', 'turn/start', 'assistant/message']))).toBe(1)
  })

  it('has no boundary before the first completed turn', () => {
    expect(forkBoundary([])).toBeUndefined()
    expect(forkBoundary(at(['user/message', 'turn/start']))).toBeUndefined()
  })
})

describe('request parsing', () => {
  it('parses and labels models against the catalog', () => {
    const models = parseModels([{ provider: 'mock', model: 'alpha' }, { provider: 'mock', model: 'beta', reasoningEffort: 'low' }], 4)
    expect(labelModels(catalogGroups(CATALOG), models).map(model => model.label)).toEqual(['Alpha', 'Beta · Low'])
    expect(() => parseModels([{ provider: 'mock', model: 'alpha' }], 4)).toThrow(/Pick 2 to 4/)
    expect(() => parseModels('x', 4)).toThrow()
    expect(() => parseModels([{ provider: '', model: 'a' }, { provider: 'p', model: 'b' }], 4)).toThrow(/provider/)
    expect(() => parseModels([{ provider: 'p', model: 'a', reasoningEffort: 3 }, { provider: 'p', model: 'b' }], 4)).toThrow(/reasoningEffort/)
  })
})
