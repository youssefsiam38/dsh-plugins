/**
 * Shared real-AgentLoop harness: published dsh packages, the storage stack, a
 * scripted model with two routes, and small stand-ins for the Web-profile
 * services the plugin talks to (Web connection routes, session controller,
 * workspace registry).
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ModelCompareService, { forkBoundary } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Text of the last human message of a request. */
export function lastUserText(options: GenerateOptions): string {
  const human = options.messages.filter(message => message.role === 'user').at(-1)
  if (human === undefined) return ''
  return human.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/**
 * Scripted model on provider `mock` (models `alpha`, `beta`, `gamma`). It
 * answers `<model>: <prompt>`, reports usage and cost, and, when the prompt
 * contains `please write`, first calls the `write` tool.
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Requests wait on this gate when set (to observe a running lane). */
  gate: Promise<void> | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...model === 'beta' ? { reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('low') } } : {},
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gate !== undefined) await this.gate
    const prompt = lastUserText(options)
    const lastIsToolResult = options.messages.at(-1)?.role === 'tool'
    if (prompt.includes('please write') && !lastIsToolResult) {
      const id = ToolCallId(`call-${randomUUID()}`)
      const args = JSON.stringify({ path: 'out.txt', content: 'x' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const answer = `${options.model}: ${prompt}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 4, costUsd: 0.0025 } as never }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The catalog the fake controller serves. */
export const CATALOG: ModelCatalog = {
  default: { provider: 'mock', model: 'alpha' },
  routableProviders: ['mock'],
  groups: [{
    id: 'mock',
    name: 'Mock',
    models: [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      { id: 'gamma', name: 'Gamma' },
    ],
  }],
  failures: [],
}

/** One exact route as the Web connection registers it. */
export interface FakeRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Stand-in for the Web connection's exact-route registry. */
export class FakeConnection extends Service {
  static current: FakeConnection | undefined
  readonly routes = new Map<string, FakeRoute>()
  readonly fetch = {
    register: (route: FakeRoute): (() => Promise<void>) => {
      this.routes.set(route.path, route)
      return () => {
        this.routes.delete(route.path)
        return Promise.resolve()
      }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
    FakeConnection.current = this
  }
}

/**
 * Stand-in for the session controller: resolves live agents, serves the
 * catalog, and forks like `session/fork` (latest completed prefix, default
 * model, a fresh `session-<uuid>` id).
 */
export class FakeController extends Service {
  static inject = ['agents']
  static current: FakeController | undefined
  readonly forks: AgentHandle[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
    FakeController.current = this
  }

  resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: { code: string; message: string } }> {
    const agent = this.ctx.agents.get(sessionId)
    return Promise.resolve(agent === undefined ? { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } } : { agent })
  }

  modelCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CATALOG)
  }

  async fork(request: { sessionId: SessionId }): Promise<{ sessionId: SessionId }> {
    const source = this.ctx.agents.get(request.sessionId)
    if (source === undefined) throw new Error('not found')
    const events = source.session.snapshotEvents()
    const boundary = forkBoundary(events)
    if (boundary === undefined) throw new Error('no completed turn')
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      seed: buildForkSeed(events, SessionSeq(boundary)),
      inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { ...source.session.header.cwd === undefined ? {} : { cwd: source.session.header.cwd }, parentSession: source.id, isSeeded: true },
      agentOptions: { provider: source.options.provider ?? 'mock', model: source.options.model ?? 'alpha' },
    })
    this.forks.push(handle)
    return { sessionId }
  }
}

/** Stand-in for the workspace registry: one workspace, an archive set. */
export class FakeWorkspaces extends Service {
  static current: FakeWorkspaces | undefined
  readonly sessionIds: SessionId[] = []
  readonly archived = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
    FakeWorkspaces.current = this
  }

  list(): Array<{ id: string; sessionIds: readonly SessionId[]; attachSession(id: SessionId): Promise<void> }> {
    return [{
      id: 'ws-1',
      sessionIds: this.sessionIds,
      attachSession: (id) => {
        this.sessionIds.push(id)
        return Promise.resolve()
      },
    }]
  }

  archiveSession(sessionId: SessionId): Promise<void> {
    this.archived.add(sessionId)
    return Promise.resolve()
  }
}

/** A mounted runtime. */
export interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly source: Agent
  readonly workspaces: FakeWorkspaces
  readonly controller: FakeController
  /** Calls of the `write` tool that actually ran. */
  readonly writes: unknown[]
  post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  say(agent: Agent, text: string): Promise<void>
  dispose(): Promise<void>
}

/** Storage-stack plugins mounted in one context. */
export async function mountStorage(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
}

/**
 * Mount the harness with a source session that already has one completed turn.
 * @param config - plugin configuration.
 * @param options - `storageRoot` reuses a storage directory (restart tests).
 * @param options.storageRoot - storage directory to reuse.
 * @returns the harness.
 */
export async function mountHarness(config: Config = {}, options: { storageRoot?: string } = {}): Promise<Harness> {
  const root = options.storageRoot ?? await mkdtemp(join(tmpdir(), 'dsh-model-compare-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-model-compare-ws-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountStorage(ctx, join(root, 'storage'))
  await ctx.plugin(FakeConnection)
  await ctx.plugin(FakeController)
  await ctx.plugin(FakeWorkspaces)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const writes: unknown[] = []
  for (const name of ['read', 'write']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} a file`,
      parameters: {},
      async execute(args) {
        if (name === 'write') writes.push(args)
        return [{ type: 'text', text: 'ok' }]
      },
    }))
  }
  await ctx.plugin(ModelCompareService, config)
  const connection = FakeConnection.current!
  const workspaces = FakeWorkspaces.current!
  const created = await ctx.agents.create({
    sessionId: SessionId(`source-${randomUUID()}`),
    agentOptions: { provider: 'mock', model: 'alpha' },
    meta: { cwd },
  })
  workspaces.sessionIds.push(created.agent.id)
  const say = async (agent: Agent, text: string): Promise<void> => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  await say(created.agent, 'first question')
  return {
    ctx,
    adapter,
    source: created.agent,
    workspaces,
    controller: FakeController.current!,
    writes,
    async post(path, body) {
      const route = connection.routes.get(path)
      if (route === undefined) throw new Error(`no route ${path}`)
      const response = await route.fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body) }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    say,
    async dispose() {
      await created.dispose()
      await ctx.fiber.dispose()
      if (options.storageRoot === undefined) await rm(root, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

/**
 * Wait until every agent of a list is idle after its queued work.
 * @param agents - agents to wait for.
 */
export async function settle(agents: readonly (Agent | undefined)[]): Promise<void> {
  // A followup wakes the loop asynchronously; let it enter before waiting.
  await new Promise(resolve => setTimeout(resolve, 20))
  await Promise.all(agents.map(agent => agent?.whenIdle()))
}
