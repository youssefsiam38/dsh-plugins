/** A pending retry survives a process restart: the schedule is recomputed from the stored log. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionRetryService from '../src/index.ts'
import { phaseAt } from '../src/decision.ts'
import { flush, ScriptedAdapter } from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

async function mountRuntime(root: string, adapter: ScriptedAdapter, withPlugin = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (withPlugin) await ctx.plugin(SessionRetryService, {})
  return ctx
}

async function disposeContext(ctx: Context): Promise<void> {
  contexts.splice(contexts.indexOf(ctx), 1)
  await ctx.fiber.dispose()
}

describe('restart', () => {
  it('reschedules a pending retry from the stored log and runs it once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-retry-'))
    roots.push(root)
    const sessionId = SessionId('retry-restart')

    const firstAdapter = new ScriptedAdapter()
    firstAdapter.script.push({ kind: 'fail', code: 'TRANSPORT' })
    const first = await mountRuntime(root, firstAdapter)
    const created = await first.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'deploy' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    const before = first.sessionRetry.view(sessionId)
    expect(before?.status).toBe('pending')
    await first.sessions.flush(created.agent.session)
    await created.dispose()
    await disposeContext(first)

    // The process was down past slot 2 and slot 3.
    const slot3 = before!.slots[1]!
    vi.setSystemTime(slot3.at + 1)

    const secondAdapter = new ScriptedAdapter()
    secondAdapter.script.push({ kind: 'text', text: 'deployed' })
    const second = await mountRuntime(root, secondAdapter)
    const resumed = await second.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    // Same schedule on the new host: every value comes from the log.
    expect(second.sessionRetry.view(sessionId)).toEqual(before)
    expect(phaseAt(before!, Date.now())).toMatchObject({ kind: 'waiting', due: { attempt: 3 }, next: { attempt: 4 } })

    await vi.advanceTimersByTimeAsync(0)
    await flush()
    await resumed.agent.whenIdle()
    await flush()
    expect(secondAdapter.requests).toHaveLength(1)
    // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
    const retries = resumed.agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'session-retry' ? [event.data.source] : [])
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ attempt: 3, trigger: 'schedule' })
    expect(second.sessionRetry.view(sessionId)).toBeNull()
    await resumed.dispose()
  })

  it('leaves a log that stock dsh reopens and continues after the plugin is uninstalled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-retry-'))
    roots.push(root)
    const sessionId = SessionId('retry-uninstall')
    const adapter = new ScriptedAdapter()
    adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'text', text: 'recovered' })
    const withPlugin = await mountRuntime(root, adapter)
    const created = await withPlugin.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'deploy' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    expect(withPlugin.sessionRetry.retryNow(sessionId)).toEqual({ ok: true, attempt: 2 })
    await created.agent.whenIdle()
    await withPlugin.sessions.flush(created.agent.session)
    await created.dispose()
    await disposeContext(withPlugin)

    const stockAdapter = new ScriptedAdapter()
    stockAdapter.script.push({ kind: 'text', text: 'still here' })
    const stock = await mountRuntime(root, stockAdapter, false)
    const resumed = await stock.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    const texts = resumed.agent.session.deriveMessages().map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    expect(texts).toEqual(expect.arrayContaining([
      'deploy',
      '(Automatic retry 2/25: the connection to the model provider failed. Continue the previous request.)',
      'recovered',
    ]))
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    expect(stockAdapter.requests).toHaveLength(1)
    await resumed.dispose()
  })
})
