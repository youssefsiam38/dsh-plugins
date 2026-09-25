/**
 * Lane tool policy. A lane runs in the same workspace as its source session
 * and its siblings, so by default it gets no tools at all; `read-only` keeps
 * a configured allowlist of tools that only read. Two layers enforce it on
 * the lane's own scope:
 * - `tools.restrict` removes every other tool from the model's tool list and
 *   from dispatch;
 * - `tools.guard` denies every other call after the `tools/pre-execute`
 *   waterfall, where no listener can override it. It also covers the PTC
 *   `run_code` transport and tools registered on the lane's own layer, which
 *   `restrict` leaves visible.
 * @module dsh-model-compare/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { LaneToolMode } from './types.ts'

/** Tools that only read, kept by the `read-only` mode when they exist. */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = ['read', 'read_image', 'grep', 'glob']

/** Denial text the model sees when a lane calls a tool it may not use. */
export const DENIAL = 'Tools are turned off in model comparison lanes. Answer from the conversation alone.'

/** What a restriction left visible. */
export interface AppliedPolicy {
  readonly mode: LaneToolMode
  /** Allowed tool names (empty for `none`; every name for `all`). */
  readonly allowed: readonly string[]
  /** Lifts both layers. */
  readonly dispose: () => void
}

/**
 * Apply the lane policy to one agent scope. Call it from the agent's setup,
 * or from `agent/created` for a resumed lane, before its first request.
 * @param agentCtx - the agent's own context (`agent.ctx`, or the setup context).
 * @param agent - the lane agent.
 * @param mode - the configured mode.
 * @param readOnlyTools - allowlist used by `read-only`.
 * @returns the applied policy.
 */
export function applyLanePolicy(agentCtx: Context, agent: Agent, mode: LaneToolMode, readOnlyTools: readonly string[]): AppliedPolicy {
  if (mode === 'all') return { mode, allowed: [], dispose: () => {} }
  const candidates = mode === 'read-only' ? readOnlyTools : []
  // Only names the lane can see: `restrict` fails on unknown names, and a
  // missing tool narrows the lane further, never widens it.
  const allowed = candidates.filter(name => agentCtx.tools.get(name, agent) !== undefined)
  const allowedSet = new Set(allowed)
  const lifts: Array<() => void> = []
  try {
    lifts.push(agentCtx.tools.restrict({ allow: allowed }))
    lifts.push(agentCtx.tools.guard(execution => allowedSet.has(execution.name) ? undefined : DENIAL))
  } catch (error: unknown) {
    for (const lift of lifts.reverse()) lift()
    throw error
  }
  return {
    mode,
    allowed,
    dispose: () => { for (const lift of lifts.reverse()) lift() },
  }
}
