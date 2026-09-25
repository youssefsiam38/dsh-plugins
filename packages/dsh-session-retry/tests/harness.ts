/** Shared real-AgentLoop harness: published dsh packages, a scripted model, and this plugin. */

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SessionRetryService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One scripted model response. */
export type Step =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'fail'; readonly code: string; readonly message?: string; readonly status?: number }
  | { readonly kind: 'tool'; readonly name: string }

/** Model adapter that plays a script and records every request. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly script: Step[] = []
  private calls = 0

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift() ?? { kind: 'text', text: 'done' }
    if (step.kind === 'fail') {
      throw new LlmError(step.message ?? step.code, step.code, step.status === undefined ? {} : { status: step.status })
    }
    if (step.kind === 'tool') {
      this.calls += 1
      const id = ToolCallId(`call-${this.calls}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: step.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A mounted runtime with one production agent. */
export interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  /** Queue a person's message and wait until the agent is idle again. */
  say(text: string): Promise<void>
  /** Texts of every logged user message with its source kind. */
  userMessages(): Array<{ kind: string; text: string; source: Record<string, unknown> }>
  dispose(): Promise<void>
}

/** State of the fake remote dependency used by the tool fixture. */
export const service = { online: true }

/**
 * Mount the harness.
 * @param config - plugin configuration.
 * @param options - extra mount hooks.
 * @param options.beforePlugin - runs after the loop mounts and before the plugin loads.
 * @returns the harness.
 */
export async function mountHarness(config: Config = {}, options: { beforePlugin?: (ctx: Context) => Promise<void> | void } = {}): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineTool({
    name: 'charge_card',
    description: 'Charge a card through the payments API',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'charged' }],
    },
    execute: () => {
      if (!service.online) return Promise.reject(new Error('Payments API is unreachable; the charge was not attempted'))
      return Promise.resolve({})
    },
  }))
  await options.beforePlugin?.(ctx)
  await ctx.plugin(SessionRetryService, config)
  const agent = await ctx.agentLoop.create(SessionId(`retry-${Math.random().toString(36).slice(2)}`), { provider: 'mock', model: 'mock' })
  return {
    ctx,
    adapter,
    agent,
    async say(text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    userMessages() {
      // oxlint-disable-next-line typescript/no-deprecated -- test read of the full log.
      return agent.session.snapshotEvents().flatMap((event) => {
        if (event.type !== 'user/message') return []
        const source = event.data.source as unknown as Record<string, unknown>
        const text = event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')
        return [{ kind: String(source['kind']), text, source }]
      })
    },
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}

/** Let queued microtasks and zero-delay work run. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}
