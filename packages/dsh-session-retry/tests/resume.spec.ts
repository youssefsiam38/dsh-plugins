/**
 * Start-up sweep: after a restart, stored sessions with a waiting retry chain
 * are loaded through the host's session-open path without anyone opening
 * them, and the latest missed slot runs once.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import SessionRetryService, { DEFAULT_BACKOFF, resumeHorizonMs } from '../src/index.ts'
import type { Config, SessionRetryView } from '../src/index.ts'
import { isWakeable } from '../src/resume.ts'
import { ScriptedAdapter } from './harness.ts'

const DAY_MS = 86_400_000
const AGENT_OPTIONS = { provider: 'mock', model: 'mock' }

/** Stands in for the Web session controller: opening a session resumes its agent. */
class TestSessionController extends Service {
  static inject = ['agents']
  readonly opened: SessionId[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  async resolveAgent(sessionId: SessionId): Promise<{ agent: Agent }> {
    this.opened.push(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live }
    return { agent: (await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: AGENT_OPTIONS })).agent }
  }
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

interface Host {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly controller: TestSessionController
  /** Info and warning lines the host logged. */
  readonly logs: string[]
}

/** Stands in for the Web workspace registry's archive list. */
class TestWorkspaceRegistry extends Service {
  constructor(ctx: Context, readonly archivedSessionIds: SessionId[]) {
    super(ctx, 'workspaceRegistry')
  }
}

async function mountHost(root: string, config: Config, options: { cache?: boolean; archived?: SessionId[] } = {}): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: ({ type, args }) => { if (type === 'info' || type === 'warn') logs.push(String(args[0])) },
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root: join(root, 'storages') })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  if (options.cache ?? true) await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 })
  if (options.archived !== undefined) await ctx.plugin(TestWorkspaceRegistry, options.archived)
  await ctx.plugin(TestSessionController)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionRetryService, config)
  const controller: TestSessionController = ctx.get('sessionController')
  return { ctx, adapter, controller, logs }
}

async function stopHost(host: Host): Promise<void> {
  contexts.splice(contexts.indexOf(host.ctx), 1)
  await host.ctx.fiber.dispose()
}

/** Create a session whose first turn runs `say` against the scripted model. */
async function runSession(host: Host, root: string, id: string, say: string): Promise<Agent> {
  const { agent } = await host.ctx.agents.create({ sessionId: SessionId(id), agentOptions: AGENT_OPTIONS, meta: { cwd: root } })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: say }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

/** Wait until the projection cache holds each session's latest event, as it does once the host has been up for `writeIntervalMs`. */
async function checkpointed(host: Host, agents: readonly Agent[]): Promise<void> {
  const cache = host.ctx.sessionProjectionCache
  await vi.waitFor(() => {
    for (const agent of agents) {
      // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
      const last = agent.session.snapshotEvents().at(-1)!.seq
      expect(cache.cachedSnapshot(agent.session.header)?.asOfSeq).toBeGreaterThanOrEqual(last)
    }
  }, { timeout: 10_000 })
}

function retrySources(agent: Agent): unknown[] {
  // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
  return agent.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'session-retry' ? [event.data.source] : [])
}

describe('start-up sweep', () => {
  it('loads only sessions with a waiting retry and runs the latest missed slot once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-retry-resume-'))
    roots.push(root)
    const now = Date.UTC(2026, 8, 1)

    const first = await mountHost(root, { resumeDelaySeconds: 0 })
    // Failed 40 days ago: past the horizon.
    vi.setSystemTime(now - 40 * DAY_MS)
    first.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' })
    const old = await runSession(first, root, 'retry-old', 'old deploy')

    vi.setSystemTime(now)
    // Attempt 1 fails, and so does attempt 2 one second later; attempt 3 is 16 s after that.
    first.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'fail', code: 'TRANSPORT' })
    const pending = await runSession(first, root, 'retry-pending', 'deploy')
    await vi.waitFor(() => { expect(first.ctx.sessionRetry.view(pending.id)?.failedAttempt).toBe(2) }, { timeout: 10_000 })
    await pending.whenIdle()
    const view = first.ctx.sessionRetry.view(pending.id)!
    expect(view.status).toBe('pending')

    first.adapter.script.push(
      { kind: 'fail', code: 'TRANSPORT' },
      { kind: 'text', text: 'fine' },
      { kind: 'fail', code: 'AUTH', status: 401 },
    )
    const stopped = await runSession(first, root, 'retry-stopped', 'migrate')
    const stop = await first.ctx.commands.execute(stopped, '/retry stop', [], new AbortController().signal)
    expect(stop?.result).toEqual({ kind: 'success', text: 'Automatic retries stopped.' })
    await stopped.whenIdle()
    const done = await runSession(first, root, 'retry-done', 'say hi')
    const auth = await runSession(first, root, 'retry-auth', 'not retryable')
    expect(first.controller.opened).toEqual([])
    await checkpointed(first, [old, pending, stopped, done, auth])
    await stopHost(first)

    // The host was down past slot 3 and slot 4; nobody opens a session after the restart.
    vi.setSystemTime(view.slots[1]!.at + 1)
    const second = await mountHost(root, { resumeDelaySeconds: 0 })
    second.adapter.script.push({ kind: 'text', text: 'deployed' })
    await vi.waitFor(() => { expect(second.adapter.requests).toHaveLength(1) }, { timeout: 10_000 })
    const resumed = second.ctx.agents.get(SessionId('retry-pending'))!
    await resumed.whenIdle()
    await vi.waitFor(() => { expect(second.ctx.sessionRetry.view(resumed.id)).toBeNull() })

    expect(second.controller.opened).toEqual([SessionId('retry-pending')])
    for (const id of ['retry-old', 'retry-stopped', 'retry-done', 'retry-auth']) {
      expect(second.ctx.agents.get(SessionId(id))).toBeUndefined()
    }
    // Attempt 2 ran before the restart; after it only the latest missed slot (4) runs.
    const retries = retrySources(resumed)
    expect(retries).toHaveLength(2)
    expect(retries[0]).toMatchObject({ attempt: 2, trigger: 'schedule' })
    expect(retries[1]).toMatchObject({ attempt: 4, trigger: 'schedule' })
    expect(second.adapter.requests).toHaveLength(1)
    expect(second.logs.filter(line => line.startsWith('session-retry:'))).toEqual([
      expect.stringMatching(/^session-retry: start-up sweep resumed 1 of 1 sessions with a waiting retry \(5 stored, 0 failed, \d+ ms\)$/),
    ])
  })

  it('reads the stored log when no projection cache is mounted, and skips archived sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-retry-resume-'))
    roots.push(root)
    const first = await mountHost(root, { resumeDelaySeconds: 0 }, { cache: false })
    first.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'fail', code: 'TRANSPORT' })
    const pending = await runSession(first, root, 'retry-log', 'deploy')
    first.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'fail', code: 'TRANSPORT' })
    const archived = await runSession(first, root, 'retry-archived', 'deploy too')
    await vi.waitFor(() => {
      expect(first.ctx.sessionRetry.view(pending.id)?.failedAttempt).toBe(2)
      expect(first.ctx.sessionRetry.view(archived.id)?.failedAttempt).toBe(2)
    }, { timeout: 10_000 })
    await first.ctx.sessions.flush(pending.session)
    await first.ctx.sessions.flush(archived.session)
    await stopHost(first)

    const second = await mountHost(root, { resumeDelaySeconds: 0 }, { cache: false, archived: [archived.id] })
    await vi.waitFor(() => { expect(second.controller.opened).toEqual([pending.id]) }, { timeout: 10_000 })
    expect(second.ctx.sessionRetry.view(pending.id)?.status).toBe('pending')
    expect(second.ctx.agents.get(archived.id)).toBeUndefined()
  })

  it('opens nothing when resumeOnStart is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-retry-resume-'))
    roots.push(root)
    const first = await mountHost(root, { resumeDelaySeconds: 0 })
    first.adapter.script.push({ kind: 'fail', code: 'TRANSPORT' }, { kind: 'fail', code: 'TRANSPORT' })
    const pending = await runSession(first, root, 'retry-off', 'deploy')
    await checkpointed(first, [pending])
    await stopHost(first)

    const second = await mountHost(root, { resumeOnStart: false, resumeDelaySeconds: 0 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(second.controller.opened).toEqual([])
    expect(second.ctx.agents.get(SessionId('retry-off'))).toBeUndefined()
  })
})

describe('resume horizon', () => {
  const budget = { maxAttempts: 25, backoff: DEFAULT_BACKOFF }
  const view: SessionRetryView = {
    status: 'pending',
    failedAttempt: 1,
    maxAttempts: 25,
    failedAt: 0,
    slots: [{ attempt: 2, at: 1000 }, { attempt: 3, at: 20_000 }],
    giveUpAt: 30_000,
    conditionId: 'builtin:transport',
    reason: 'x',
    waitsForReadiness: false,
  }

  it('covers every backoff of the budget at its largest jitter', () => {
    // 1^4 + … + 25^4 seconds (about 24.9 days) plus 10%.
    expect(resumeHorizonMs(budget) / DAY_MS).toBeCloseTo(27.4, 1)
  })

  it('wakes a waiting chain inside the horizon only', () => {
    expect(isWakeable(view, 25_000, resumeHorizonMs(budget))).toBe(true)
    expect(isWakeable(view, 30_000, resumeHorizonMs(budget))).toBe(false)
    expect(isWakeable({ ...view, giveUpAt: Number.MAX_SAFE_INTEGER }, 10_000, 5_000)).toBe(false)
    expect(isWakeable({ ...view, status: 'running', sentAttempt: 2 }, 25_000, resumeHorizonMs(budget))).toBe(false)
    expect(isWakeable(null, 25_000, resumeHorizonMs(budget))).toBe(false)
  })
})
