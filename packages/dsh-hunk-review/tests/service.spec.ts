/** The routes against a real turn: git-recorded changes, keep, revert through the file service, conflicts, and the note to the agent. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTES } from '../src/index.ts'
import type { RevertResponse, TurnReview, TurnSummary } from '../src/types.ts'
import { mountHarness } from './harness.ts'
import type { Harness } from './harness.ts'

const ORIGINAL = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'

/** Two separate edits (lines 3 and 25) and one new file. */
async function agentEdits(cwd: string): Promise<void> {
  const lines = ORIGINAL.split('\n')
  lines[2] = 'line 3 changed by the agent'
  lines[24] = 'line 25 changed by the agent'
  await writeFile(join(cwd, 'a.txt'), lines.join('\n'))
  await writeFile(join(cwd, 'new.txt'), 'hello\nworld\n')
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function review(h: Harness, seq: number): Promise<TurnReview> {
  const response = await h.call(ROUTES.review, { method: 'GET', query: { sessionId: h.agent.id, seq } })
  expect(response.status).toBe(200)
  return response.body as unknown as TurnReview
}

describe('hunk review routes', () => {
  it('reviews a turn: summary, one hunk per separate edit, statuses from the file', { timeout: 60_000 }, async () => {
    const h = harness = await mountHarness({ 'a.txt': ORIGINAL })
    const seq = await h.turn('edit please', () => agentEdits(h.cwd))
    const summary = await h.call(ROUTES.summary, { method: 'GET', query: { sessionId: h.agent.id, seq } })
    expect(summary.body as unknown as TurnSummary).toMatchObject({ turn: 1, total: 2, added: 4, deleted: 2 })
    const turn = await review(h, seq)
    const a = turn.files.find(file => file.path === 'a.txt')!
    const created = turn.files.find(file => file.path === 'new.txt')!
    expect(a.hunks.map(hunk => hunk.status)).toEqual(['pending', 'pending'])
    expect(a.hunks[0]!.lines).toContain('+line 3 changed by the agent')
    expect(created).toMatchObject({ before: false, after: true })
    const missing = await h.call(ROUTES.review, { method: 'GET', query: { sessionId: h.agent.id, seq: 9999 } })
    expect(missing.status).toBe(404)
  })

  it('reverts one hunk, keeps the other, and tells the agent at its next request', { timeout: 60_000 }, async () => {
    const h = harness = await mountHarness({ 'a.txt': ORIGINAL })
    const seq = await h.turn('edit please', () => agentEdits(h.cwd))
    const turn = await review(h, seq)
    const index = turn.files.find(file => file.path === 'a.txt')!.index

    const kept = await h.call(ROUTES.keep, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'hunk', index, hunk: 1 } } })
    expect((kept.body as unknown as TurnReview).files.find(file => file.index === index)!.hunks.map(hunk => hunk.status)).toEqual(['pending', 'kept'])

    const requestsBefore = h.adapter.requests.length
    const reverted = await h.call(ROUTES.revert, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'hunk', index, hunk: 0 } } })
    expect(reverted.status).toBe(200)
    const answer = reverted.body as unknown as RevertResponse
    expect(answer.results).toEqual([{ index, hunk: 0, outcome: 'reverted' }])
    expect(answer.notified).toBe(true)
    expect(answer.review.files.find(file => file.index === index)!.hunks.map(hunk => hunk.status)).toEqual(['reverted', 'kept'])
    const text = await readFile(join(h.cwd, 'a.txt'), 'utf8')
    expect(text).toContain('\nline 3\n')
    expect(text).toContain('line 25 changed by the agent')
    // Queued, not sent: no request until the user writes.
    expect(h.adapter.requests.length).toBe(requestsBefore)

    await h.say('next')
    const sent = JSON.stringify(h.adapter.requests.at(-1)!.messages)
    expect(sent).toContain('reverted the hunk below')
    expect(sent).toContain('<file path=\\"a.txt\\">')
    expect(sent).toContain('+line 3 changed by the agent')
    const logs = await h.storedLogs()
    expect(logs).toContain('"kind":"hunk-review"')
  })

  it('reverts a whole file, leaves kept hunks, and a created file ends empty', { timeout: 60_000 }, async () => {
    const h = harness = await mountHarness({ 'a.txt': ORIGINAL })
    const seq = await h.turn('edit please', () => agentEdits(h.cwd))
    const turn = await review(h, seq)
    const a = turn.files.find(file => file.path === 'a.txt')!.index
    await h.call(ROUTES.keep, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'hunk', index: a, hunk: 0 } } })
    const all = await h.call(ROUTES.revert, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'all' } } })
    const answer = all.body as unknown as RevertResponse
    expect(answer.results.filter(result => result.outcome === 'reverted')).toHaveLength(2)
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toContain('line 3 changed by the agent')
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toContain('\nline 25\n')
    expect(await readFile(join(h.cwd, 'new.txt'), 'utf8')).toBe('')
  })

  it('refuses a hunk the file no longer matches and shows how it differs; re-diff sees a later fix', { timeout: 60_000 }, async () => {
    const h = harness = await mountHarness({ 'a.txt': ORIGINAL })
    const seq = await h.turn('edit please', () => agentEdits(h.cwd))
    const index = (await review(h, seq)).files.find(file => file.path === 'a.txt')!.index
    const edited = (await readFile(join(h.cwd, 'a.txt'), 'utf8')).replace('line 3 changed by the agent', 'line 3 edited by me')
    await writeFile(join(h.cwd, 'a.txt'), edited)

    const turn = await review(h, seq)
    const conflict = turn.files.find(file => file.index === index)!.hunks[0]!
    expect(conflict.status).toBe('conflict')
    expect(conflict.drift).toEqual(expect.arrayContaining(['-line 3 changed by the agent', '+line 3 edited by me']))

    const refused = await h.call(ROUTES.revert, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'hunk', index, hunk: 0 } } })
    expect((refused.body as unknown as RevertResponse).results).toEqual([{ index, hunk: 0, outcome: 'conflict' }])
    expect((refused.body as unknown as RevertResponse).notified).toBe(false)
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe(edited)

    await writeFile(join(h.cwd, 'a.txt'), edited.replace('line 3 edited by me', 'line 3 changed by the agent'))
    expect((await review(h, seq)).files.find(file => file.index === index)!.hunks[0]!.status).toBe('pending')
  })

  it('refuses reverts while the agent is running and validates targets', { timeout: 60_000 }, async () => {
    const h = harness = await mountHarness({ 'a.txt': ORIGINAL })
    const seq = await h.turn('edit please', () => agentEdits(h.cwd))
    const bad = await h.call(ROUTES.revert, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'hunk', index: 0, hunk: 99 } } })
    expect(bad.status).toBe(404)
    const invalid = await h.call(ROUTES.keep, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'lines' } } })
    expect(invalid.status).toBe(400)

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    h.adapter.hold = held
    h.agent.followup((await import('@deepseek-ai/dsh-llm')).createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await expect.poll(() => h.agent.status).toBe('running')
    const busy = await h.call(ROUTES.revert, { method: 'POST', body: { sessionId: h.agent.id, seq, target: { scope: 'all' } } })
    expect(busy.status).toBe(409)
    release()
    await h.agent.whenIdle()
  })
})
