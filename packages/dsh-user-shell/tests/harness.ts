/** Shared real-AgentLoop harness: published dsh packages, a scripted model, the local subprocess and spill providers, and this plugin. */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import UserShellService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { UserShellEvent } from '../src/types.ts'

/** Model adapter that answers every request and records it. */
export class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One exact route as the Web connection registers it. */
export interface FakeRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** Stand-in for the Web connection's exact-route registry (the external HTTP carrier). */
export class FakeConnection extends Service {
  /** The most recently mounted instance. */
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

/** A mounted runtime with one production agent. */
export interface Harness {
  readonly ctx: Context
  readonly adapter: RecordingAdapter
  readonly agent: Agent
  readonly cwd: string
  readonly root: string
  readonly connection: FakeConnection | undefined
  /** Live hub events since mount. */
  readonly events: UserShellEvent[]
  /** POST a JSON body to a plugin route. */
  post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  /** Wait for the `end` event of a run. */
  ended(commandId: string): Promise<Extract<UserShellEvent, { type: 'end' }>>
  /** Queue a person's message and wait until the agent is idle again. */
  say(text: string): Promise<void>
  /** Every stored session file under the persistence root, as text. */
  storedLogs(): Promise<string>
  /** Every event in the live log, as JSON text. */
  liveLog(): string
  dispose(): Promise<void>
}

/**
 * Mount the harness.
 * @param config - plugin configuration.
 * @param options - `web: false` mounts no Web connection (a headless profile).
 * @param options.web - whether the Web connection exists.
 * @param options.env - PATH and other environment for commands.
 * @returns the harness.
 */
export async function mountHarness(config: Config = {}, options: { web?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-user-shell-store-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-user-shell-ws-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  let connection: FakeConnection | undefined
  if (options.web !== false) {
    await ctx.plugin(FakeConnection)
    connection = FakeConnection.current
  }
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(UserShellService, config)
  const events: UserShellEvent[] = []
  ctx.userShell.hub.subscribe((event) => { events.push(event) })
  const created = await ctx.agents.create({
    sessionId: SessionId(`shell-${Math.random().toString(36).slice(2)}`),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd },
  })
  const agent = created.agent
  return {
    ctx,
    adapter,
    agent,
    cwd,
    root,
    connection,
    events,
    async post(path, body) {
      const route = connection?.routes.get(path)
      if (route === undefined) throw new Error(`no route ${path}`)
      const response = await route.fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body) }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    async ended(commandId) {
      for (let waited = 0; waited < 30_000; waited += 20) {
        const end = events.find((event): event is Extract<UserShellEvent, { type: 'end' }> => event.type === 'end' && event.commandId === commandId)
        if (end !== undefined) {
          // Let the handler finish its log writes after the hub event.
          await new Promise(resolve => setTimeout(resolve, 50))
          return end
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`run ${commandId} did not end`)
    },
    async say(text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async storedLogs() {
      await ctx.sessions.flush(agent.session)
      const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
      const texts = await Promise.all(files.map(file => readFile(join(root, 'sessions', file), 'utf8')))
      return texts.join('\n')
    },
    liveLog() {
      // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
      return agent.session.snapshotEvents().map(event => JSON.stringify(event)).join('\n')
    },
    async dispose() {
      await created.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

/**
 * Text of every message of one model request.
 * @param request - recorded request.
 * @returns concatenated text blocks.
 */
export function requestText(request: GenerateOptions): string {
  return JSON.stringify(request.messages)
}
