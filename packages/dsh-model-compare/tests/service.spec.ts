/** The comparison lifecycle in the published agent loop with a scripted model. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DENIAL, PROJECTION_KEY, ROUTES } from '../src/index.ts'
import type { CompareRecord, CompareStateResponse } from '../src/types.ts'
import { lastUserText, mountHarness, settle } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const TWO = [{ provider: 'mock', model: 'alpha' }, { provider: 'mock', model: 'beta', reasoningEffort: 'high' }]

async function start(h: Harness, prompt = 'compare me', models: unknown = TWO): Promise<CompareRecord> {
  const response = await h.post(ROUTES.start, { sessionId: h.source.id, prompt, models })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body['compare'] as CompareRecord
}

function lanes(h: Harness, record: CompareRecord): Agent[] {
  return record.lanes.map(lane => h.ctx.agents.get(SessionId(lane.sessionId))!)
}

function toolNames(h: Harness, agent: Agent): string[] {
  const request = h.adapter.requests.find(candidate => candidate.model === agent.options.model && lastUserText(candidate) !== 'first question')
  return (request?.tools ?? []).map(tool => tool.name).sort()
}

describe('starting a comparison', () => {
  it('forks one lane per model, sends the prompt to each, and leaves the source alone', async () => {
    harness = await mountHarness()
    const h = harness
    const sourceEvents = h.source.session.seq
    const before = h.adapter.requests.length
    const record = await start(h)
    expect(record.lanes.map(lane => lane.label)).toEqual(['Alpha', 'Beta · High'])
    expect(record.status).toBe('open')
    const agents = lanes(h, record)
    await settle(agents)

    const requests = h.adapter.requests.slice(before)
    expect(requests.map(request => request.model).sort()).toEqual(['alpha', 'beta'])
    for (const request of requests) {
      const text = JSON.stringify(request.messages)
      // Each lane inherits the source history and answers the new prompt.
      expect(text).toContain('first question')
      expect(lastUserText(request)).toBe('compare me')
      expect(request.tools ?? []).toEqual([])
    }
    const beta = requests.find(request => request.model === 'beta')!
    expect(beta.reasoningEffort).toBe('high')
    expect(beta.maxTokens).toBe(8192)

    for (const agent of agents) {
      expect(agent.session.header.parentSession).toBe(h.source.id)
      expect(agent.session.header.cwd).toBe(h.source.session.header.cwd)
    }
    expect(h.workspaces.sessionIds).toEqual(expect.arrayContaining(record.lanes.map(lane => lane.sessionId)))
    expect(h.source.session.seq).toBe(sourceEvents)
  })

  it('publishes per-lane statistics from the lane events', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h)
    const agents = lanes(h, record)
    await settle(agents)
    const snapshot = h.ctx.sessionProjections.snapshot(agents[0]!.session, [PROJECTION_KEY])
    const view = snapshot.values[PROJECTION_KEY]!
    expect(view).toMatchObject({
      phase: 'ended',
      outcome: 'completed',
      inputTokens: 150,
      outputTokens: 20,
      reasoningTokens: 4,
      cacheReadTokens: 50,
      costUnreported: 0,
      requests: 1,
      provider: 'mock',
      model: 'alpha',
    })
    expect(view.costUsd).toBeCloseTo(0.0025)
    expect(view.latencyMs).toBeGreaterThanOrEqual(0)
    expect(view.ttftMs).toBeGreaterThanOrEqual(0)
    // The source's own first turn is not a comparison turn, but folds the same way.
    expect(h.ctx.sessionProjections.snapshot(h.source.session, [PROJECTION_KEY]).values[PROJECTION_KEY]?.phase).toBe('ended')
  })

  it('refuses bad requests', async () => {
    harness = await mountHarness({ maxModels: 3 })
    const h = harness
    const post = (body: Record<string, unknown>) => h.post(ROUTES.start, { sessionId: h.source.id, prompt: 'p', models: TWO, ...body })
    expect((await post({ models: [TWO[0]] })).status).toBe(400)
    expect((await post({ models: [...TWO, ...TWO] })).status).toBe(400)
    expect((await post({ models: [TWO[0], { provider: 'mock', model: 'nope' }] })).body['error']).toMatch(/not in the model catalog/)
    expect((await post({ models: [TWO[0], { provider: 'mock', model: 'beta', reasoningEffort: 'max' }] })).body['error']).toMatch(/no reasoning effort/)
    expect((await post({ models: [TWO[0], { provider: 'mock', model: 'alpha', reasoningEffort: 'high' }] })).status).toBe(400)
    expect((await post({ prompt: '   ' })).status).toBe(400)
    expect((await post({ sessionId: 'missing' })).status).toBe(404)
    expect(h.workspaces.sessionIds).toEqual([h.source.id])
  })

  it('allows one open comparison per session and none started from a lane', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h)
    await settle(lanes(h, record))
    const again = await h.post(ROUTES.start, { sessionId: h.source.id, prompt: 'x', models: TWO })
    expect(again.status).toBe(409)
    const fromLane = await h.post(ROUTES.start, { sessionId: record.lanes[0]!.sessionId, prompt: 'x', models: TWO })
    expect(fromLane.status).toBe(409)
    const state = await h.post(ROUTES.state, { sessionId: h.source.id })
    const body = state.body as unknown as CompareStateResponse
    expect(body.compare?.compareId).toBe(record.compareId)
    expect(body.settings).toMatchObject({ minModels: 2, maxModels: 4, tools: 'none' })
    expect(body.catalog.groups[0]!.models.map(model => model.id)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('lane tools', () => {
  it('gives lanes no tools by default and denies a call the model makes anyway', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h, 'please write a file')
    const agents = lanes(h, record)
    await settle(agents)
    expect(toolNames(h, agents[0]!)).toEqual([])
    expect(h.writes).toEqual([])
    const log = JSON.stringify(agents[0]!.session.snapshotEvents())
    expect(log).toContain('"tool/result"')
    // The source keeps every tool.
    expect(h.ctx.tools.get('write', h.source)).toBeDefined()
    expect(h.ctx.tools.get('write', agents[0]!)).toBeUndefined()
  })

  it('keeps only the read-only allowlist in read-only mode, and the guard still denies writes', async () => {
    harness = await mountHarness({ tools: 'read-only', readOnlyTools: ['read', 'grep'] })
    const h = harness
    const record = await start(h, 'please write a file')
    const agents = lanes(h, record)
    await settle(agents)
    expect(toolNames(h, agents[0]!)).toEqual(['read'])
    expect(h.writes).toEqual([])
    expect(h.ctx.tools.get('read', agents[0]!)).toBeDefined()
  })

  it('leaves every tool in all mode', async () => {
    harness = await mountHarness({ tools: 'all' })
    const h = harness
    const record = await start(h, 'please write a file')
    await settle(lanes(h, record))
    expect(h.writes).toHaveLength(2)
  })

  it('re-applies the policy to a lane session created again under its id', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h)
    const lane = record.lanes[0]!
    await settle(lanes(h, record))
    // Discarding disposes the lane agents; a new agent on a lane id is restricted from `agent/created`.
    await h.post(ROUTES.discard, { compareId: record.compareId })
    const again = await h.ctx.agents.create({ sessionId: SessionId(lane.sessionId), agentOptions: { provider: 'mock', model: 'alpha' }, meta: { cwd: h.source.session.header.cwd! } })
    expect(h.ctx.tools.get('write', again.agent)).toBeUndefined()
    expect(h.ctx.tools.get('read', again.agent)).toBeUndefined()
    await again.dispose()
  })

  it('exposes the denial text the guard returns', () => {
    expect(DENIAL).toMatch(/Tools are turned off/)
  })
})

describe('closing a comparison', () => {
  it('adopts a finished lane: forks it, archives the lanes and the source, and closes the record', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h)
    await settle(lanes(h, record))
    const beta = record.lanes[1]!
    const adopted = await h.post(ROUTES.adopt, { compareId: record.compareId, laneSessionId: beta.sessionId })
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200)
    const continuation = h.ctx.agents.get(SessionId(adopted.body['sessionId'] as string))!
    expect(continuation.session.header.parentSession).toBe(beta.sessionId)
    expect(JSON.stringify(continuation.session.snapshotEvents())).toContain('beta: compare me')
    // The continuation is an ordinary session with every tool.
    expect(h.ctx.tools.get('write', continuation)).toBeDefined()
    expect([...h.workspaces.archived].sort()).toEqual([...record.lanes.map(lane => lane.sessionId), h.source.id].sort())
    expect(h.ctx.modelCompare.get(record.compareId)).toMatchObject({ status: 'adopted', adoptedLane: beta.sessionId, continuation: continuation.id })
    const state = await h.post(ROUTES.state, { sessionId: h.source.id })
    expect(state.body['compare']).toBeNull()
    expect((await h.post(ROUTES.adopt, { compareId: record.compareId, laneSessionId: beta.sessionId })).status).toBe(409)
  })

  it('keeps the source when archiveSourceOnAdopt is off', async () => {
    harness = await mountHarness({ archiveSourceOnAdopt: false })
    const h = harness
    const record = await start(h)
    await settle(lanes(h, record))
    await h.post(ROUTES.adopt, { compareId: record.compareId, laneSessionId: record.lanes[0]!.sessionId })
    expect(h.workspaces.archived.has(h.source.id)).toBe(false)
  })

  it('refuses to adopt a lane that is still answering, and stops it on request', async () => {
    harness = await mountHarness()
    const h = harness
    let open!: () => void
    h.adapter.gate = new Promise((resolve) => { open = resolve })
    const record = await start(h)
    const agents = lanes(h, record)
    await expect.poll(() => agents.every(agent => agent.status === 'running')).toBe(true)
    const early = await h.post(ROUTES.adopt, { compareId: record.compareId, laneSessionId: record.lanes[0]!.sessionId })
    expect(early.status).toBe(409)
    const stopped = await h.post(ROUTES.stop, { compareId: record.compareId, laneSessionId: record.lanes[0]!.sessionId })
    expect(stopped.body['stopped']).toEqual([record.lanes[0]!.sessionId])
    open()
    await settle(agents)
    const view = h.ctx.sessionProjections.snapshot(agents[0]!.session, [PROJECTION_KEY]).values[PROJECTION_KEY]!
    expect(view.phase).toBe('ended')
    expect(view.outcome).toBe('aborted')
    expect(h.ctx.sessionProjections.snapshot(agents[1]!.session, [PROJECTION_KEY]).values[PROJECTION_KEY]!.outcome).toBe('completed')
  })

  it('discards: archives the lanes only', async () => {
    harness = await mountHarness()
    const h = harness
    const record = await start(h)
    await settle(lanes(h, record))
    const discarded = await h.post(ROUTES.discard, { compareId: record.compareId })
    expect(discarded.status).toBe(200)
    expect([...h.workspaces.archived].sort()).toEqual(record.lanes.map(lane => lane.sessionId).sort())
    expect(h.ctx.modelCompare.get(record.compareId)?.status).toBe('discarded')
    expect((await h.post(ROUTES.discard, { compareId: record.compareId })).status).toBe(409)
    expect((await h.post(ROUTES.discard, { compareId: 'nope' })).status).toBe(404)
  })
})

describe('storage', () => {
  it('keeps the lane index across a restart, so a resumed lane is restricted', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-model-compare-restart-'))
    try {
      const first = await mountHarness({}, { storageRoot })
      const record = await start(first)
      await settle(lanes(first, record))
      await first.dispose()

      harness = await mountHarness({}, { storageRoot })
      const h = harness
      const lane = record.lanes[0]!
      expect(h.ctx.modelCompare.laneOf(lane.sessionId)).toBe(record.compareId)
      const resumed = await h.ctx.agents.create({ sessionId: SessionId(lane.sessionId), agentOptions: { provider: 'mock', model: 'alpha' }, meta: { cwd: h.source.session.header.cwd! } })
      expect(h.ctx.tools.get('write', resumed.agent)).toBeUndefined()
      await resumed.dispose()
      expect((await h.post(ROUTES.state, { sessionId: record.sourceSessionId })).body['compare']).toMatchObject({ compareId: record.compareId })
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
})
