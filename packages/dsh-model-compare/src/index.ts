/**
 * `dsh-model-compare`: send one prompt to 2–4 models side by side and continue
 * with the answer you pick.
 *
 * A comparison forks the source session's history (up to its latest completed
 * turn) into one sibling session per model, the lanes. Each lane runs its own
 * model on the same prompt with no tools by default, so lanes never write to
 * the shared workspace. Adopting a lane forks it into an ordinary session
 * (full tools, the lane's model), which the browser then opens; the lanes
 * (and by default the source) are archived. Discarding archives the lanes.
 *
 * Everything the models see is logged by standard paths: lanes are created
 * from a fork seed, the prompt is one `user/message`, and the continuation is
 * a standard `session/fork`. The plugin adds no session event types.
 *
 * Comparisons start only through the authenticated Web connection
 * (`/api/model-compare/*`); profiles without it register nothing.
 * @module dsh-model-compare
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only: service declarations merged into `Context`.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { forkBoundary } from './fork.ts'
import { applyLanePolicy, DEFAULT_READ_ONLY_TOOLS } from './policy.ts'
import type { AppliedPolicy } from './policy.ts'
import { PROJECTION_KEY, statsProjection } from './projection.ts'
import { compareDomainSpec } from './store.ts'
import type { CatalogGroup, CompareLane, CompareModel, CompareRecord, CompareSettings, CompareStateResponse, LaneToolMode } from './types.ts'

export type * from './types.ts'
export { applyLanePolicy, DEFAULT_READ_ONLY_TOOLS, DENIAL } from './policy.ts'
export type { AppliedPolicy } from './policy.ts'
export { forkBoundary } from './fork.ts'
export { applyStatsEvent, foldStats, initialStats, statsView } from './stats.ts'
export type { LaneStatsState, StatsEvent } from './stats.ts'
export { PROJECTION_KEY, statsProjection, statsStateSchema, statsViewSchema } from './projection.ts'
export { compareDomainSpec, compareRecordSchema } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Side-by-side model comparisons (`dsh-model-compare`). */
    modelCompare: ModelCompareService
  }
}

/** Route paths below the Web server's `/api` channel. */
export const ROUTES = {
  state: '/api/model-compare/state',
  start: '/api/model-compare/start',
  stop: '/api/model-compare/stop',
  adopt: '/api/model-compare/adopt',
  discard: '/api/model-compare/discard',
} as const

/** Fewest models a comparison runs. */
export const MIN_MODELS = 2
/** Most models a comparison may run, whatever the configuration says. */
export const MAX_MODELS = 4

/** Plugin configuration (bundle-row `config`). */
export interface Config {
  /** Most models one comparison runs, 2–4. Default 4. */
  maxModels?: number
  /** Tools a lane may use: `none` (default), `read-only`, or `all`. */
  tools?: LaneToolMode
  /** Tools `read-only` keeps when they exist. Default `read`, `read_image`, `grep`, `glob`. */
  readOnlyTools?: string[]
  /** Output-token cap per lane request; 0 leaves the model's default. Default 8192. */
  maxOutputTokens?: number
  /** Longest prompt accepted, in characters. Default 32000. */
  maxPromptChars?: number
  /** Archive the source session when a lane is adopted (the continuation holds its whole history). Default true. */
  archiveSourceOnAdopt?: boolean
}

interface ResolvedConfig {
  readonly maxModels: number
  readonly tools: LaneToolMode
  readonly readOnlyTools: readonly string[]
  readonly maxOutputTokens: number
  readonly maxPromptChars: number
  readonly archiveSourceOnAdopt: boolean
}

/** A failed route request with its HTTP status. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch (error: unknown) {
    void error
    throw new RouteError(400, 'The request body is not JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RouteError(400, 'The request body must be a JSON object.')
  return parsed as Record<string, unknown>
}

function text(fields: Record<string, unknown>, key: string, max = 1024): string {
  const value = fields[key]
  if (typeof value !== 'string' || value.length > max) throw new RouteError(400, `"${key}" must be a string of at most ${max} characters.`)
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse the `models` field of a start request.
 * @param value - raw field.
 * @param max - most models accepted.
 * @returns the requested models.
 */
export function parseModels(value: unknown, max: number): CompareModel[] {
  if (!Array.isArray(value) || value.length < MIN_MODELS || value.length > max) {
    throw new RouteError(400, `Pick ${MIN_MODELS} to ${max} models.`)
  }
  return value.map((item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new RouteError(400, 'Each model must be an object.')
    const fields = item as Record<string, unknown>
    const provider = text(fields, 'provider', 256)
    const model = text(fields, 'model', 512)
    if (provider === '' || model === '') throw new RouteError(400, 'Each model needs a provider and a model id.')
    const effort = fields['reasoningEffort']
    if (effort !== undefined && (typeof effort !== 'string' || effort === '' || effort.length > 64)) throw new RouteError(400, '"reasoningEffort" must be a non-empty string.')
    return { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } }
  })
}

/**
 * Map the Host model catalog to the picker's groups.
 * @param catalog - the session controller's catalog.
 * @returns groups with effort choices.
 */
export function catalogGroups(catalog: ModelCatalog): CatalogGroup[] {
  return catalog.groups.map(group => ({
    id: group.id,
    name: group.name,
    models: group.models.map(model => ({
      id: model.id,
      name: model.name,
      efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
      ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
    })),
  }))
}

/**
 * Check requested models against the catalog and label them. Models the
 * catalog does not list are refused.
 * @param groups - catalog groups.
 * @param models - requested models.
 * @returns the models with their display labels.
 */
export function labelModels(groups: readonly CatalogGroup[], models: readonly CompareModel[]): Array<CompareModel & { label: string }> {
  return models.map((requested) => {
    const model = groups.find(group => group.id === requested.provider)?.models.find(candidate => candidate.id === requested.model)
    if (model === undefined) throw new RouteError(400, `The model ${requested.provider}/${requested.model} is not in the model catalog.`)
    if (requested.reasoningEffort === undefined) return { ...requested, label: model.name }
    const effort = model.efforts.find(candidate => candidate.id === requested.reasoningEffort)
    if (effort === undefined) throw new RouteError(400, `${model.name} has no reasoning effort "${requested.reasoningEffort}".`)
    return { ...requested, label: `${model.name} · ${effort.name}` }
  })
}

/**
 * The `modelCompare` service: comparison records, lane creation and tool
 * policy, the lane statistics projection, and the `/api/model-compare/*`
 * routes.
 */
export class ModelCompareService extends Service {
  static inject = ['agents', 'tools', 'sessionProjections', 'storageDomain']

  static Config: z<Config> = z.object({
    maxModels: z.natural().min(MIN_MODELS).max(MAX_MODELS).default(MAX_MODELS),
    tools: z.union(['none', 'read-only', 'all'] as const).default('none'),
    readOnlyTools: z.array(z.string()).default([...DEFAULT_READ_ONLY_TOOLS]),
    maxOutputTokens: z.natural().max(1 << 20).default(8192),
    maxPromptChars: z.natural().min(1).max(1_000_000).default(32_000),
    archiveSourceOnAdopt: z.boolean().default(true),
  })

  /** Resolved settings. */
  readonly settings: ResolvedConfig
  private compares: KvTable<string, CompareRecord> | undefined
  /** Lane session id to compare id, for every stored comparison. */
  private readonly laneIndex = new Map<string, string>()
  private readonly handles = new Map<string, AgentHandle>()
  private readonly policies = new WeakMap<Agent, AppliedPolicy>()
  private readonly starting = new Set<string>()
  private readonly ready: Promise<void>
  private markReady: (error?: unknown) => void = () => {}

  /**
   * @param ctx - plugin context.
   * @param config - validated bundle-row configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'modelCompare')
    const tools = config.tools ?? 'none'
    const readOnlyTools = config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS
    if (readOnlyTools.some(name => typeof name !== 'string' || name === '')) throw new Error('dsh-model-compare: readOnlyTools must be tool names')
    this.settings = {
      maxModels: config.maxModels ?? MAX_MODELS,
      tools,
      readOnlyTools,
      maxOutputTokens: config.maxOutputTokens ?? 8192,
      maxPromptChars: config.maxPromptChars ?? 32_000,
      archiveSourceOnAdopt: config.archiveSourceOnAdopt ?? true,
    }
    if (this.settings.maxModels < MIN_MODELS || this.settings.maxModels > MAX_MODELS) throw new Error(`dsh-model-compare: maxModels must be ${MIN_MODELS}–${MAX_MODELS}`)
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = error => error === undefined ? resolve() : reject(error)
    })
    // Keep an init failure from surfacing as an unhandled rejection; the
    // listener below still awaits and rethrows it.
    this.ready.catch((error: unknown) => { void error })

    ctx.effect(() => ctx.sessionProjections.register(statsProjection()), 'model-compare: lane statistics')
    // Resumed lanes (after a Host restart, or reopened from the sidebar) get
    // the lane policy before their first request. Creation fails when it
    // cannot be applied.
    ctx.on('agent/created', async ({ agent }) => {
      await this.ready
      if (this.laneIndex.has(agent.id) && !this.policies.has(agent)) this.restrict(agent.ctx, agent)
      return undefined
    })
    ctx.effect(() => () => {
      for (const handle of this.handles.values()) void handle.dispose()
      this.handles.clear()
    }, 'model-compare: lane agents')
    ctx.inject(['connection', 'sessionController', 'workspaceRegistry'], (web) => {
      this.registerRoutes(web)
    })
  }

  protected async [Service.init](): Promise<void> {
    try {
      const domain = await this.ctx.storageDomain.open(compareDomainSpec)
      this.ctx.effect(() => () => domain.close(), 'model-compare: storage')
      this.compares = domain.table('compares')
      for (const [compareId, record] of this.compares.entries()) {
        for (const lane of record.lanes) this.laneIndex.set(lane.sessionId, compareId)
      }
      this.markReady()
    } catch (error: unknown) {
      this.markReady(error)
      throw error
    }
  }

  /**
   * Whether a session is a comparison lane.
   * @param sessionId - session id.
   * @returns the lane's compare id, or undefined.
   */
  laneOf(sessionId: string): string | undefined {
    return this.laneIndex.get(sessionId)
  }

  /**
   * One stored comparison.
   * @param compareId - compare id.
   * @returns the record, or undefined.
   */
  get(compareId: string): CompareRecord | undefined {
    return this.compares?.get(compareId)
  }

  /**
   * The open comparison started from a session.
   * @param sourceSessionId - source session id.
   * @returns the newest open record, or undefined.
   */
  openFor(sourceSessionId: string): CompareRecord | undefined {
    let found: CompareRecord | undefined
    for (const [, record] of this.compares?.entries() ?? []) {
      if (record.sourceSessionId !== sourceSessionId || record.status !== 'open') continue
      if (found === undefined || record.createdAt > found.createdAt) found = record
    }
    return found
  }

  /**
   * Settings as the browser receives them.
   * @returns the public settings.
   */
  publicSettings(): CompareSettings {
    return {
      minModels: MIN_MODELS,
      maxModels: this.settings.maxModels,
      tools: this.settings.tools,
      maxPromptChars: this.settings.maxPromptChars,
      maxOutputTokens: this.settings.maxOutputTokens,
    }
  }

  private restrict(agentCtx: Context, agent: Agent): void {
    this.policies.set(agent, applyLanePolicy(agentCtx, agent, this.settings.tools, this.settings.readOnlyTools))
  }

  private table(): KvTable<string, CompareRecord> {
    if (this.compares === undefined) throw new RouteError(503, 'Model comparison storage is not ready.')
    return this.compares
  }

  private async sourceAgent(web: Context, sessionId: string): Promise<Agent> {
    if (this.laneIndex.has(sessionId)) throw new RouteError(409, 'Start comparisons from a regular session, not from a comparison lane.')
    const resolved = await web.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) throw new RouteError(resolved.error.code === 'session/not-found' ? 404 : 409, resolved.error.message)
    return resolved.agent
  }

  /**
   * Start a comparison.
   * @param web - context carrying the Web services.
   * @param sourceSessionId - the session to compare from.
   * @param prompt - the prompt every lane answers.
   * @param models - the models, one lane each.
   * @returns the stored record.
   */
  async start(web: Context, sourceSessionId: string, prompt: string, models: readonly CompareModel[]): Promise<CompareRecord> {
    await this.ready
    const table = this.table()
    if (this.starting.has(sourceSessionId) || this.openFor(sourceSessionId) !== undefined) {
      throw new RouteError(409, 'A comparison is already open for this session. Continue with an answer or discard it first.')
    }
    this.starting.add(sourceSessionId)
    try {
      const source = await this.sourceAgent(web, sourceSessionId)
      const cwd = source.session.header.cwd
      if (cwd === undefined) throw new RouteError(409, 'This session has no working directory.')
      const labelled = labelModels(catalogGroups(await web.sessionController.modelCatalog()), models)
      // oxlint-disable-next-line typescript/no-deprecated -- full history of a live session, as the controller's fork reads it.
      const events = source.session.snapshotEvents()
      const boundary = forkBoundary(events)
      const seed = boundary === undefined ? undefined : buildForkSeed(events, SessionSeq(boundary))
      const presetId = this.ctx.sessionProjections.stateOf(source.session, 'agentPreset') ?? undefined
      const workspace = web.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(source.id))
      const sourceTitle = this.ctx.get('sessionTitle')?.get(source.session)?.title
      const record: CompareRecord = {
        compareId: randomUUID(),
        sourceSessionId,
        prompt,
        createdAt: Date.now(),
        tools: this.settings.tools,
        status: 'open',
        lanes: labelled.map((model): CompareLane => ({ ...model, sessionId: `session-${randomUUID()}` })),
      }
      // The lane index must name every lane before its session exists.
      await table.put(record.compareId, record)
      for (const lane of record.lanes) this.laneIndex.set(lane.sessionId, record.compareId)

      const agents: Agent[] = []
      try {
        for (const lane of record.lanes) {
          const handle = await this.ctx.agents.create({
            sessionId: SessionId(lane.sessionId),
            ...seed === undefined || boundary === undefined ? {} : { seed, inheritedEventCount: SessionLogOffset(boundary + 1) },
            meta: {
              cwd,
              parentSession: source.id,
              ...seed === undefined ? {} : { isSeeded: true },
              ...presetId === undefined ? {} : { agentPreset: presetId },
            },
            agentOptions: {
              provider: lane.provider,
              model: lane.model,
              ...lane.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(lane.reasoningEffort) },
              ...this.settings.maxOutputTokens === 0 ? {} : { maxTokens: this.settings.maxOutputTokens },
            },
            setup: async (agentCtx, agent) => {
              const presets = this.ctx.get('agentPresets')
              if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
              this.restrict(agentCtx, agent)
            },
          })
          this.handles.set(lane.sessionId, handle)
          agents.push(handle.agent)
          if (workspace !== undefined) await workspace.attachSession(handle.agent.id)
          this.rename(handle.agent, `${lane.label} — ${sourceTitle ?? excerpt(prompt)}`)
        }
      } catch (error: unknown) {
        await this.close(web, record, 'discarded', [])
        throw new RouteError(500, `The comparison could not start: ${errorText(error)}`)
      }
      for (const agent of agents) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      }
      return record
    } finally {
      this.starting.delete(sourceSessionId)
    }
  }

  /**
   * Stop running lanes.
   * @param compareId - compare id.
   * @param laneSessionId - one lane, or every lane when undefined.
   * @returns the lanes a stop was sent to.
   */
  stop(compareId: string, laneSessionId: string | undefined): string[] {
    const record = this.requireOpen(compareId)
    const lanes = laneSessionId === undefined ? record.lanes : record.lanes.filter(lane => lane.sessionId === laneSessionId)
    if (lanes.length === 0) throw new RouteError(404, 'The lane is not part of this comparison.')
    const stopped: string[] = []
    for (const lane of lanes) {
      const agent = this.ctx.agents.get(SessionId(lane.sessionId))
      if (agent === undefined) continue
      agent.cancel({ kind: 'user' })
      stopped.push(lane.sessionId)
    }
    return stopped
  }

  /**
   * Continue with one lane's answer: fork the lane into an ordinary session,
   * then archive the lanes (and the source when configured).
   * @param web - context carrying the Web services.
   * @param compareId - compare id.
   * @param laneSessionId - the lane to adopt.
   * @returns the session the conversation continues in.
   */
  async adopt(web: Context, compareId: string, laneSessionId: string): Promise<string> {
    const record = this.requireOpen(compareId)
    if (!record.lanes.some(lane => lane.sessionId === laneSessionId)) throw new RouteError(404, 'The lane is not part of this comparison.')
    const resolved = await web.sessionController.resolveAgent(SessionId(laneSessionId))
    if ('error' in resolved) throw new RouteError(409, resolved.error.message)
    const stats = this.ctx.sessionProjections.stateOf(resolved.agent.session, PROJECTION_KEY)
    if (stats === undefined || stats.endedAt === null || resolved.agent.status !== 'idle') {
      throw new RouteError(409, 'This model is still answering. Wait for it to finish or stop it first.')
    }
    let continuation: string
    try {
      continuation = (await web.sessionController.fork({ sessionId: SessionId(laneSessionId) })).sessionId
    } catch (error: unknown) {
      throw new RouteError(409, `The answer could not be adopted: ${errorText(error)}`)
    }
    const source = this.ctx.agents.get(SessionId(record.sourceSessionId))
    const title = source === undefined ? undefined : this.ctx.get('sessionTitle')?.get(source.session)?.title
    const next = this.ctx.agents.get(SessionId(continuation))
    if (title !== undefined && next !== undefined) this.rename(next, title)
    const archive = this.settings.archiveSourceOnAdopt ? [record.sourceSessionId] : []
    await this.close(web, { ...record, adoptedLane: laneSessionId, continuation }, 'adopted', archive)
    return continuation
  }

  /**
   * Discard a comparison: stop and archive its lanes.
   * @param web - context carrying the Web services.
   * @param compareId - compare id.
   */
  async discard(web: Context, compareId: string): Promise<void> {
    const record = this.requireOpen(compareId)
    await this.close(web, record, 'discarded', [])
  }

  private requireOpen(compareId: string): CompareRecord {
    const record = this.table().get(compareId)
    if (record === undefined) throw new RouteError(404, 'The comparison does not exist.')
    if (record.status !== 'open') throw new RouteError(409, 'The comparison is already closed.')
    return record
  }

  private async close(web: Context, record: CompareRecord, status: 'adopted' | 'discarded', alsoArchive: readonly string[]): Promise<void> {
    await this.table().put(record.compareId, { ...record, status })
    for (const lane of record.lanes) this.ctx.agents.get(SessionId(lane.sessionId))?.cancel({ kind: 'user' })
    for (const sessionId of [...record.lanes.map(lane => lane.sessionId), ...alsoArchive]) {
      try {
        await web.workspaceRegistry.archiveSession(SessionId(sessionId), { stopActivity: true })
      } catch (error: unknown) {
        this.ctx.logger.warn(`model-compare: session ${sessionId} was not archived: ${errorText(error)}`)
      }
    }
    for (const lane of record.lanes) {
      const handle = this.handles.get(lane.sessionId)
      this.handles.delete(lane.sessionId)
      await handle?.dispose()
    }
  }

  private rename(agent: Agent, title: string): void {
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) return
    try {
      titles.rename(agent.session, title.slice(0, 120))
    } catch (error: unknown) {
      this.ctx.logger.warn(`model-compare: session ${agent.id} was not renamed: ${errorText(error)}`)
    }
  }

  private registerRoutes(web: Context): void {
    const route = (path: string, handler: (fields: Record<string, unknown>) => Promise<unknown>): void => {
      web.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return json(await handler(await body(request)))
          } catch (error: unknown) {
            if (error instanceof RouteError) return json({ error: error.message }, error.status)
            web.logger.warn(`model-compare: ${path} failed: ${errorText(error)}`)
            return json({ error: 'The request failed.' }, 500)
          }
        },
      })
    }

    route(ROUTES.state, async (fields): Promise<CompareStateResponse> => {
      const sessionId = text(fields, 'sessionId')
      await this.ready
      const catalog = await web.sessionController.modelCatalog()
      return {
        settings: this.publicSettings(),
        catalog: {
          default: catalog.default,
          groups: catalogGroups(catalog),
          failures: catalog.failures.map(failure => ({ id: failure.id, name: failure.name, message: failure.message })),
        },
        compare: this.openFor(sessionId) ?? null,
      }
    })

    route(ROUTES.start, async (fields) => {
      const sessionId = text(fields, 'sessionId')
      const prompt = text(fields, 'prompt', this.settings.maxPromptChars).trim()
      if (prompt === '') throw new RouteError(400, 'Type a prompt to compare.')
      const models = parseModels(fields['models'], this.settings.maxModels)
      return { compare: await this.start(web, sessionId, prompt, models) }
    })

    route(ROUTES.stop, async (fields) => {
      await this.ready
      const lane = fields['laneSessionId']
      if (lane !== undefined && typeof lane !== 'string') throw new RouteError(400, '"laneSessionId" must be a string.')
      return { stopped: this.stop(text(fields, 'compareId'), lane) }
    })

    route(ROUTES.adopt, async (fields) => {
      await this.ready
      return { sessionId: await this.adopt(web, text(fields, 'compareId'), text(fields, 'laneSessionId')) }
    })

    route(ROUTES.discard, async (fields) => {
      await this.ready
      await this.discard(web, text(fields, 'compareId'))
      return { ok: true }
    })
  }
}

function excerpt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

export default ModelCompareService
