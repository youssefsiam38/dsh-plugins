/**
 * Shared real-AgentLoop harness: published dsh packages, a scripted model that
 * edits files during its turn, the real workspace-changes recorder over git,
 * the local file service, and this plugin behind a stand-in Web connection.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import HunkReviewService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Model adapter that records each request. While `edit` is armed, it answers
 * with one `apply_edit` tool call (the tool runs `edit` inside the turn);
 * otherwise it answers with text after awaiting `hold`.
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** The edit the next `apply_edit` call runs. */
  edit: (() => void | Promise<void>) | undefined
  /** Awaited before a text answer, once. */
  hold: Promise<void> | undefined
  private calls = 0

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.edit !== undefined) {
      this.calls += 1
      const id = ToolCallId(`edit-${this.calls}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'apply_edit', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'apply_edit', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    await this.hold
    this.hold = undefined
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

/**
 * Create a git repository with committed files.
 * @param files - file name to content.
 * @returns the repository directory.
 */
export async function gitRepo(files: Record<string, string>): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hunk-review-ws-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  }
  git('init', '-q')
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  return dir
}

/** A mounted runtime with one production agent. */
export interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly cwd: string
  readonly connection: FakeConnection
  /** Call a plugin route. */
  call(path: string, init: { method: 'GET'; query: Record<string, string | number> } | { method: 'POST'; body: unknown }): Promise<{ status: number; body: Record<string, unknown> }>
  /** Run one turn whose model step runs `edit`; resolves with the `workspace/changes` sequence. */
  turn(text: string, edit: () => void | Promise<void>): Promise<number>
  /** Queue a message and wait until the agent is idle again. */
  say(text: string): Promise<void>
  /** Every stored session file, as text. */
  storedLogs(): Promise<string>
  dispose(): Promise<void>
}

/**
 * Mount the harness.
 * @param files - committed files of the workspace repository.
 * @param config - plugin configuration.
 * @returns the harness.
 */
export async function mountHarness(files: Record<string, string>, config: Config = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hunk-review-store-'))
  const cwd = await gitRepo(files)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(WorkspaceChanges, { timeoutMs: 30_000, outputMaxBytes: 8 * 1024 * 1024, maxFiles: 500, maxFileBytes: 2 * 1024 * 1024, diffTimeoutMs: 1000 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(FakeConnection)
  const connection = FakeConnection.current!
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineTool({
    name: 'apply_edit',
    description: 'Apply the scripted edit',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'edited' }] },
    execute: async () => {
      const edit = adapter.edit
      adapter.edit = undefined
      await edit?.()
      return {}
    },
  }))
  await ctx.plugin(HunkReviewService, config)
  const created = await ctx.agents.create({
    sessionId: SessionId(`review-${Math.random().toString(36).slice(2)}`),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd },
  })
  const agent = created.agent
  const say = async (text: string): Promise<void> => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return {
    ctx,
    adapter,
    agent,
    cwd,
    connection,
    async call(path, init) {
      const route = connection.routes.get(path)
      if (route === undefined) throw new Error(`no route ${path}`)
      const request = init.method === 'GET'
        ? new Request(`http://127.0.0.1${path}?${new URLSearchParams(Object.entries(init.query).map(([key, value]) => [key, String(value)]))}`)
        : new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(init.body) })
      const response = await route.fetch(request)
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    async turn(text, edit) {
      adapter.edit = edit
      await say(text)
      // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
      const events = agent.session.snapshotEvents()
      const announced = events.filter(event => event.type === 'workspace/changes').at(-1)
      if (announced === undefined) throw new Error('the turn announced no workspace changes')
      return announced.seq
    },
    say,
    async storedLogs() {
      await ctx.sessions.flush(agent.session)
      const found = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
      return (await Promise.all(found.map(file => readFile(join(root, 'sessions', file), 'utf8')))).join('\n')
    },
    async dispose() {
      await created.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    },
  }
}
