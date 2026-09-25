import { describe, expect, it } from 'vitest'
import {
  backoffSeconds, backoffSecondsWithoutJitter, MAX_BACKOFF_SECONDS, retrySchedule, slotRandom, totalBackoffSeconds,
} from '../src/policy.ts'

const SECOND = 1
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('backoff policy', () => {
  it('waits attempt^4 seconds after each failed attempt', () => {
    const expected: Array<[number, number]> = [
      [1, 1 * SECOND],
      [2, 16 * SECOND],
      [3, 1 * MINUTE + 21 * SECOND],
      [4, 4 * MINUTE + 16 * SECOND],
      [5, 10 * MINUTE + 25 * SECOND],
      [6, 21 * MINUTE + 36 * SECOND],
      [7, 40 * MINUTE + 1 * SECOND],
      [8, 1 * HOUR + 8 * MINUTE + 16 * SECOND],
      [9, 1 * HOUR + 49 * MINUTE + 21 * SECOND],
      [10, 2 * HOUR + 46 * MINUTE + 40 * SECOND],
      [11, 4 * HOUR + 4 * MINUTE + 1 * SECOND],
      [12, 5 * HOUR + 45 * MINUTE + 36 * SECOND],
      [13, 7 * HOUR + 56 * MINUTE + 1 * SECOND],
      [14, 10 * HOUR + 40 * MINUTE + 16 * SECOND],
      [15, 14 * HOUR + 3 * MINUTE + 45 * SECOND],
      [16, 18 * HOUR + 12 * MINUTE + 16 * SECOND],
      [17, 23 * HOUR + 12 * MINUTE + 1 * SECOND],
      [18, 1 * DAY + 5 * HOUR + 9 * MINUTE + 36 * SECOND],
      [19, 1 * DAY + 12 * HOUR + 12 * MINUTE + 1 * SECOND],
      [20, 1 * DAY + 20 * HOUR + 26 * MINUTE + 40 * SECOND],
      [21, 2 * DAY + 6 * HOUR + 1 * MINUTE + 21 * SECOND],
      [22, 2 * DAY + 17 * HOUR + 4 * MINUTE + 16 * SECOND],
      [23, 3 * DAY + 5 * HOUR + 44 * MINUTE + 1 * SECOND],
      [24, 3 * DAY + 20 * HOUR + 9 * MINUTE + 36 * SECOND],
    ]
    for (const [attempt, seconds] of expected) expect(backoffSecondsWithoutJitter(attempt)).toBe(seconds)
  })

  it('applies a symmetric ±10% jitter from the supplied sample', () => {
    expect(backoffSeconds(10, 0)).toBeCloseTo(10_000 * 0.9, 9)
    expect(backoffSeconds(10, 0.5)).toBeCloseTo(10_000, 9)
    expect(backoffSeconds(10, 0.999_999)).toBeCloseTo(10_000 * 1.1, 2)
    for (let attempt = 1; attempt < 25; attempt += 1) {
      const base = backoffSecondsWithoutJitter(attempt)
      for (const sample of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999_999]) {
        const wait = backoffSeconds(attempt, sample)
        expect(wait).toBeGreaterThanOrEqual(base * 0.9 - 1e-9)
        expect(wait).toBeLessThan(base * 1.1)
      }
    }
  })

  it('caps at the largest 64-bit nanosecond duration and drops jitter there', () => {
    expect(backoffSecondsWithoutJitter(309)).toBeLessThan(MAX_BACKOFF_SECONDS)
    expect(backoffSecondsWithoutJitter(310)).toBe(MAX_BACKOFF_SECONDS)
    expect(backoffSecondsWithoutJitter(1_000_000)).toBe(MAX_BACKOFF_SECONDS)
    expect(backoffSeconds(310, 0)).toBe(MAX_BACKOFF_SECONDS)
    expect(backoffSeconds(309, 0.999_999)).toBeLessThanOrEqual(MAX_BACKOFF_SECONDS)
  })

  it('spends about 20.4 days of waits across a 25-attempt budget', () => {
    const total = totalBackoffSeconds(25)
    expect(total).toBe(1_763_020)
    expect(total / DAY).toBeCloseTo(20.4, 1)
  })

  it('derives the jitter sample deterministically from the log coordinates', () => {
    const sample = slotRandom('session-a', 42, 3)
    expect(slotRandom('session-a', 42, 3)).toBe(sample)
    expect(sample).toBeGreaterThanOrEqual(0)
    expect(sample).toBeLessThan(1)
    expect(slotRandom('session-a', 42, 4)).not.toBe(sample)
    expect(slotRandom('session-b', 42, 3)).not.toBe(sample)
    const samples = Array.from({ length: 2_000 }, (_, index) => slotRandom('s', index, 1))
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
  })

  it('schedules attempts 2…max after the original failure and gives up one backoff after the last slot', () => {
    const schedule = retrySchedule({ sessionId: 's', failureSeq: 7, failedAt: 0, failedAttempt: 1, maxAttempts: 25 })
    expect(schedule.slots.map(slot => slot.attempt)).toEqual(Array.from({ length: 24 }, (_, index) => index + 2))
    const first = schedule.slots[0]!
    expect(first.at).toBe(Math.round(backoffSeconds(1, slotRandom('s', 7, 1)) * 1000))
    for (let index = 1; index < schedule.slots.length; index += 1) {
      const previous = schedule.slots[index - 1]!
      const slot = schedule.slots[index]!
      expect(slot.at - previous.at).toBe(Math.round(backoffSeconds(previous.attempt, slotRandom('s', 7, previous.attempt)) * 1000))
    }
    const last = schedule.slots.at(-1)!
    expect(last.at / 1000 / DAY).toBeGreaterThan(20.4 * 0.9)
    expect(last.at / 1000 / DAY).toBeLessThan(20.4 * 1.1)
    expect(schedule.giveUpAt - last.at).toBe(Math.round(backoffSeconds(25, slotRandom('s', 7, 25)) * 1000))
  })

  it('continues numbering from a failed retry and has no slots once the budget is spent', () => {
    const later = retrySchedule({ sessionId: 's', failureSeq: 9, failedAt: 1_000, failedAttempt: 13, maxAttempts: 25 })
    expect(later.slots[0]).toEqual({ attempt: 14, at: 1_000 + Math.round(backoffSeconds(13, slotRandom('s', 9, 13)) * 1000) })
    const spent = retrySchedule({ sessionId: 's', failureSeq: 9, failedAt: 1_000, failedAttempt: 25, maxAttempts: 25 })
    expect(spent).toEqual({ slots: [], giveUpAt: 1_000 })
  })
})
