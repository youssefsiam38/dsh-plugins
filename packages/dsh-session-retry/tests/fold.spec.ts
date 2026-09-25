import { describe, expect, it } from 'vitest'
import { builtinConditions, DEFAULT_BUILTIN_CONDITIONS } from '../src/conditions.ts'
import { firstMatch, phaseAt, retryView } from '../src/decision.ts'
import type { FoldEvent } from '../src/fold.ts'
import { foldRetryEvents, latestFailure } from '../src/fold.ts'
import { DEFAULT_BACKOFF } from '../src/policy.ts'
import type { RetryFailure } from '../src/types.ts'

let seq = 0
function event(type: string, data: unknown, time = 1_000): FoldEvent {
  return { type, seq: seq++, time, data }
}
function user(text: string, kind = 'user', extra: Record<string, unknown> = {}): FoldEvent {
  return event('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind, ...extra } })
}
function turn(n: number, reason: unknown, body: FoldEvent[] = []): FoldEvent[] {
  return [event('turn/start', { turn: n }), ...body, event('turn/end', { turn: n, reason })]
}
const transport = { kind: 'error', error: { code: 'TRANSPORT', message: 'socket hang up' } }
const budget = { maxAttempts: 25, backoff: DEFAULT_BACKOFF }

function failure(end: RetryFailure['end']): RetryFailure {
  return { sessionId: 's', turn: 1, end, toolResults: [], llmRetries: [] }
}

describe('fold', () => {
  it('collects tool results, provider retries, and the route of the latest turn', () => {
    const state = foldRetryEvents('s', [
      event('request/context', { provider: 'openrouter', model: 'm' }),
      ...turn(1, { kind: 'completed' }, [
        user('go'),
        event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' }),
        event('tool/result', {
          turn: 1, step: 1,
          message: { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'Machine "build-01" is offline; the operation was not attempted' }] },
          error: { name: 'FsError', code: 'FS_IO_ERROR', reason: 'offline' },
        }),
        event('llm/retry', { provider: 'openrouter', failure: { code: 'SERVER', message: 'bad gateway', status: 502 } }),
      ]),
    ])
    expect(latestFailure(state)).toEqual({
      sessionId: 's',
      turn: 1,
      end: { kind: 'completed' },
      toolResults: [{
        toolName: 'read_file',
        isError: true,
        errorText: 'Machine "build-01" is offline; the operation was not attempted',
        errorName: 'FsError',
        errorCode: 'FS_IO_ERROR',
        errorReason: 'offline',
      }],
      llmRetries: [{ provider: 'openrouter', code: 'SERVER', message: 'bad gateway', status: 502 }],
      provider: 'openrouter',
      model: 'm',
    })
  })

  it('numbers a turn started by a retry continuation with its attempt', () => {
    const state = foldRetryEvents('s', [
      ...turn(1, transport, [user('go')]),
      ...turn(2, transport, [user('(retry)', 'session-retry', { attempt: 2, maxAttempts: 25, conditionId: 'builtin:transport', reason: 'r', trigger: 'schedule' })]),
    ])
    expect(state.last?.attempt).toBe(2)
    expect(state.sentAttempt).toBeNull()
  })

  it('treats only a person\'s message as superseding; injected context does not', () => {
    const base = turn(1, transport, [user('go')])
    expect(foldRetryEvents('s', [...base, user('reminder', 'schedule')]).superseded).toBe(false)
    expect(foldRetryEvents('s', [...base, user('new request')]).superseded).toBe(true)
  })

  it('stops only on a successful /retry stop', () => {
    const base = turn(1, transport, [user('go')])
    const failed = foldRetryEvents('s', [
      ...base,
      event('command/run', { commandId: 'a', name: 'retry', args: ' stop', source: { kind: 'ui' } }),
      event('command/done', { commandId: 'a', kind: 'error', text: 'no' }),
    ])
    expect(failed.stopped).toBe(false)
    const stopped = foldRetryEvents('s', [
      ...base,
      event('command/run', { commandId: 'b', name: 'retry', args: ' stop', source: { kind: 'ui' } }),
      event('command/done', { commandId: 'b', kind: 'success' }),
    ])
    expect(stopped.stopped).toBe(true)
    expect(foldRetryEvents('s', [...base, event('command/run', { commandId: 'c', name: 'retry', args: ' stop', source: { kind: 'ui' } }), event('command/done', { commandId: 'c', kind: 'success' }), ...turn(2, transport)]).stopped).toBe(false)
  })

  it('ignores a fork-inherited prefix', () => {
    seq = 0
    const events = turn(1, transport, [user('go')])
    expect(foldRetryEvents('s', events, events.length).last).toBeNull()
  })
})

describe('built-in conditions', () => {
  const conditions = builtinConditions(DEFAULT_BUILTIN_CONDITIONS)

  it('match provider stalls, transport, server errors, and rate limits by code or status', () => {
    const cases: Array<[RetryFailure['end'], string | undefined]> = [
      [{ kind: 'error', error: { code: 'LLM_STREAM_IDLE_TIMEOUT', message: '' } }, 'builtin:provider-stall'],
      [{ kind: 'error', error: { code: 'TIMEOUT', message: '' } }, 'builtin:provider-stall'],
      [{ kind: 'error', error: { code: 'TRANSPORT', message: '' } }, 'builtin:transport'],
      [{ kind: 'error', error: { code: 'SERVER', message: '', status: 500 } }, 'builtin:server-error'],
      [{ kind: 'error', error: { code: 'UNKNOWN', message: '', status: 503 } }, 'builtin:server-error'],
      [{ kind: 'error', error: { code: 'RATE_LIMIT', message: '' } }, 'builtin:rate-limit'],
      [{ kind: 'error', error: { code: 'UNKNOWN', message: '', status: 429 } }, 'builtin:rate-limit'],
      [{ kind: 'error', error: { code: 'INVALID_REQUEST', message: '', status: 400 } }, undefined],
      [{ kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: '', status: 401 } }, undefined],
      [{ kind: 'aborted', cause: 'user' }, undefined],
      [{ kind: 'completed' }, undefined],
      [{ kind: 'other', name: 'future' }, undefined],
    ]
    for (const [end, id] of cases) expect(firstMatch(conditions, failure(end))?.condition.id).toBe(id)
  })

  it('skips a throwing condition and reports it', () => {
    const errors: string[] = []
    const match = firstMatch([
      { id: 'broken', matches: () => { throw new Error('boom') } },
      ...conditions,
    ], failure({ kind: 'error', error: { code: 'TRANSPORT', message: '' } }), condition => errors.push(condition.id))
    expect(errors).toEqual(['broken'])
    expect(match?.condition.id).toBe('builtin:transport')
  })
})

describe('view and phase', () => {
  it('derives skipped slots and the give-up time from the clock alone', () => {
    seq = 0
    const state = foldRetryEvents('s', turn(1, transport, [user('go')]))
    const matched = firstMatch(builtinConditions(DEFAULT_BUILTIN_CONDITIONS), latestFailure(state)!)
    const view = retryView(state, matched, budget)!
    expect(phaseAt(view, view.failedAt)).toMatchObject({ kind: 'waiting', next: { attempt: 2 } })
    const slot13 = view.slots.find(slot => slot.attempt === 13)!
    expect(phaseAt(view, slot13.at + 1)).toMatchObject({ kind: 'waiting', due: { attempt: 13 }, next: { attempt: 14 } })
    expect(phaseAt(view, view.giveUpAt)).toEqual({ kind: 'exhausted' })
    expect((view.giveUpAt - view.failedAt) / 86_400_000).toBeGreaterThan(22)
    expect((view.giveUpAt - view.failedAt) / 86_400_000).toBeLessThan(28)
  })
})
