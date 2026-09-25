/**
 * `dsh-user-shell`: shell commands the user runs from the Web composer.
 *
 * `!cmd` runs in the session workspace and adds the result to the model's
 * context for its next request without starting a turn; `!!cmd` runs without
 * adding anything to the context. Both are recorded as a `command/run` /
 * `command/done` pair of the `sh` / `shq` commands, which are also the
 * fallback syntax (`/sh cmd`, `/shq cmd`) on hosts whose composer lacks
 * line-prefix sources. A `!` result reaches the model as one `user/message`
 * with source kind `user-shell`, queued with `agent.inject()`.
 *
 * Runs are started only through the authenticated Web connection (the
 * `/api/user-shell/*` routes and the Web command RPC); profiles without the
 * Web connection (headless, ACP) register nothing. No model tool exists.
 * @module dsh-user-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import { UserShellHub } from './hub.ts'
import { DEFAULT_BUDGET, frameForModel, recordText, truncateOutput } from './record.ts'
import type { OutputBudget } from './record.ts'
import { ShellRun } from './runner.ts'
import type { Spawner } from './runner.ts'
import type { UserShellEvent, UserShellMessageSource, UserShellMode } from './types.ts'

export type * from './types.ts'
export { ANSWER_SCRIPT, CLEANUP_SCRIPT, MARKER_PREFIX, MarkerParser, PRELUDE } from './askpass.ts'
export type { Marker } from './askpass.ts'
export { byteLength, DEFAULT_BUDGET, escapeFramed, frameForModel, MODEL_CAVEAT, parseRecord, recordText, truncateOutput } from './record.ts'
export type { OutputBudget, ParsedRecord, TruncatedOutput } from './record.ts'
export { ShellRun } from './runner.ts'
export type { ShellRunEvents, ShellRunOptions, ShellRunResult, Spawner } from './runner.ts'
export { UserShellHub } from './hub.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-shell': UserShellMessageSource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shell commands the user runs from the Web composer (`dsh-user-shell`). */
    userShell: UserShellService
  }
}

/** Command names: `sh` adds the result to the model's context, `shq` does not. */
export const COMMAND_NAMES: Readonly<Record<UserShellMode, string>> = { context: 'sh', quiet: 'shq' }

/** Route paths below the Web server's `/api` channel. */
export const ROUTES = {
  run: '/api/user-shell/run',
  cancel: '/api/user-shell/cancel',
  askpass: '/api/user-shell/askpass',
  events: '/api/user-shell/events',
} as const

/** System prompt line contributed while the plugin is active. */
export const GUIDANCE = 'The user can run shell commands themselves by typing `! <command>` in their message box; results they choose to share appear as user messages. You cannot use sudo: when a command needs root privileges, ask the user to run `! sudo <command>` themselves instead of trying sudo.'

/** Plugin configuration (bundle-row `config`). */
export interface Config {
  /** Seconds before a run is terminated. Default 600. */
  timeoutSeconds?: number
  /** Seconds between SIGTERM and SIGKILL when a run is cancelled or times out. Default 3. */
  killGraceSeconds?: number
  /** Seconds a sudo password prompt waits for the browser before sudo fails. Default 120. */
  askpassTimeoutSeconds?: number
  /** Put a `sudo` wrapper (`sudo -A` with a browser password prompt) first on PATH. Default true. */
  sudoAskpass?: boolean
  /** Enable `!!` / `/shq` (runs that stay out of the model's context). Default true. */
  enableQuiet?: boolean
  /** Shell that runs the command; empty uses `$SHELL` on the target, then `/bin/sh`. */
  shell?: string
  /** Extra environment for commands. Default `{ PAGER: cat, GIT_PAGER: cat, TERM: dumb }`. */
  env?: Record<string, string>
  /** Head and tail kept for the model and the log. */
  output?: Partial<OutputBudget>
  /** Bytes of complete output kept in memory and saved as the full-output file. Default 16 MiB. */
  captureBytes?: number
  /** Characters of recent output kept per run for browsers that connect mid-run. Default 65536. */
  liveOutputChars?: number
  /** Add the one-line sudo guidance to the system prompt. Default true. */
  guidance?: boolean
}

interface ResolvedConfig {
  readonly timeoutMs: number
  readonly killGraceMs: number
  readonly askpassTimeoutMs: number
  readonly sudoAskpass: boolean
  readonly enableQuiet: boolean
  readonly shell: string
  readonly env: Readonly<Record<string, string>>
  readonly budget: OutputBudget
  readonly captureBytes: number
  readonly liveOutputChars: number
  readonly guidance: boolean
}

/** Largest command accepted from the browser, in characters. */
const MAX_COMMAND_CHARS = 65_536
/** Largest password accepted, in characters. */
const MAX_PASSWORD_CHARS = 4096

const DEFAULT_ENV: Readonly<Record<string, string>> = { PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' }

interface ActiveRun {
  readonly commandId: string
  readonly sessionId: string
  readonly run: ShellRun
  /** Browser-tab token allowed to answer password prompts; undefined lets any authenticated tab answer. */
  readonly owner: string | undefined
  readonly askpassTimers: Map<string, ReturnType<typeof setTimeout>>
}

interface Ticket {
  readonly owner: string
  readonly started: (commandId: string) => void
}

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

/**
 * The `userShell` service: run registry, the `sh` / `shq` commands, the
 * `/api/user-shell/*` routes, and the live event hub.
 */
export class UserShellService extends Service {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    timeoutSeconds: z.number().min(1).max(86_400).default(600),
    killGraceSeconds: z.number().min(0.1).max(60).default(3),
    askpassTimeoutSeconds: z.number().min(5).max(3600).default(120),
    sudoAskpass: z.boolean().default(true),
    enableQuiet: z.boolean().default(true),
    shell: z.string().default(''),
    env: z.dict(z.string()).default({ ...DEFAULT_ENV }),
    output: z.object({
      headBytes: z.natural().min(256).default(DEFAULT_BUDGET.headBytes),
      headLines: z.natural().min(1).default(DEFAULT_BUDGET.headLines),
      tailBytes: z.natural().min(256).default(DEFAULT_BUDGET.tailBytes),
      tailLines: z.natural().min(1).default(DEFAULT_BUDGET.tailLines),
    }),
    captureBytes: z.natural().min(65_536).max(1 << 30).default(16 * 1024 * 1024),
    liveOutputChars: z.natural().min(1024).max(16 * 1024 * 1024).default(65_536),
    guidance: z.boolean().default(true),
  })

  /** Resolved settings. */
  readonly settings: ResolvedConfig
  /** Live event hub. */
  readonly hub: UserShellHub
  private readonly active = new Map<string, ActiveRun>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - plugin context.
   * @param config - validated bundle-row configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'userShell')
    if (config.shell !== undefined && config.shell !== '' && !config.shell.startsWith('/')) {
      throw new Error('dsh-user-shell: shell must be an absolute path or empty')
    }
    this.settings = {
      timeoutMs: (config.timeoutSeconds ?? 600) * 1000,
      killGraceMs: Math.round((config.killGraceSeconds ?? 3) * 1000),
      askpassTimeoutMs: (config.askpassTimeoutSeconds ?? 120) * 1000,
      sudoAskpass: config.sudoAskpass ?? true,
      enableQuiet: config.enableQuiet ?? true,
      shell: config.shell ?? '',
      env: config.env ?? DEFAULT_ENV,
      budget: { ...DEFAULT_BUDGET, ...config.output },
      captureBytes: config.captureBytes ?? 16 * 1024 * 1024,
      liveOutputChars: config.liveOutputChars ?? 65_536,
      guidance: config.guidance ?? true,
    }
    this.hub = new UserShellHub(this.settings.liveOutputChars, this.settings.enableQuiet)
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const active of this.active.values()) active.run.cancel()
      this.hub.dispose()
    }, 'userShell.lifetime()')

    // Runs exist only where the authenticated Web connection carries them.
    ctx.inject(['connection', 'commands', 'subprocess'], (web) => {
      this.registerCommands(web)
      this.registerRoutes(web)
      if (this.settings.guidance) {
        web.inject(['systemPrompt'], (promptCtx) => {
          promptCtx.systemPrompt.section({ name: 'user-shell', order: 900, text: GUIDANCE, interpolate: false })
        })
      }
    })
  }

  /**
   * Whether a session has a running command.
   * @param sessionId - session id.
   * @returns the running command's pairing id, or undefined.
   */
  running(sessionId: string): string | undefined {
    return this.active.get(sessionId)?.commandId
  }

  private registerCommands(web: Context): void {
    const modes: UserShellMode[] = this.settings.enableQuiet ? ['context', 'quiet'] : ['context']
    for (const mode of modes) {
      web.commands.register({
        name: COMMAND_NAMES[mode],
        description: mode === 'context'
          ? 'Run a shell command in the session workspace and add its output to the model context (same as !cmd)'
          : 'Run a shell command in the session workspace without adding it to the model context (same as !!cmd)',
        input: { hint: '<shell command>' },
        handler: invocation => this.execute(web, mode, invocation.agent, invocation.rawInput, invocation.commandId, invocation.signal),
      })
    }
  }

  private async execute(web: Context, mode: UserShellMode, agent: Agent, rawInput: string, commandId: string, signal: AbortSignal): Promise<CommandResult> {
    const command = rawInput.trim()
    const sessionId = agent.id
    const ticket = this.tickets.get(sessionId)
    this.tickets.delete(sessionId)
    if (command === '') return { kind: 'error', text: `Usage: /${COMMAND_NAMES[mode]} <shell command>` }
    if (this.active.has(sessionId)) return { kind: 'error', text: 'Another shell command is still running in this session.' }
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return { kind: 'error', text: 'This session has no working directory.' }

    const spawner: Spawner = web.subprocess
    const active: ActiveRun = {
      commandId,
      sessionId,
      owner: ticket?.owner,
      askpassTimers: new Map(),
      run: new ShellRun(spawner, {
        cwd,
        command,
        shell: this.settings.shell,
        askpass: this.settings.sudoAskpass,
        timeoutMs: this.settings.timeoutMs,
        killGraceMs: this.settings.killGraceMs,
        captureBytes: this.settings.captureBytes,
        env: this.settings.env,
      }, {
        output: (output) => { this.hub.output(commandId, output) },
        askpass: (request) => {
          active.askpassTimers.set(request.requestId, setTimeout(() => {
            void active.run.answer(request.requestId, undefined)
          }, this.settings.askpassTimeoutMs))
          this.hub.askpass(commandId, request)
        },
        askpassClosed: (requestId) => {
          const timer = active.askpassTimers.get(requestId)
          if (timer !== undefined) clearTimeout(timer)
          active.askpassTimers.delete(requestId)
          this.hub.askpassClosed(commandId, requestId)
        },
      }),
    }
    this.active.set(sessionId, active)
    this.hub.start({ commandId, sessionId, command, mode, startedAt: Date.now() })
    ticket?.started(commandId)
    const onAbort = (): void => { active.run.cancel() }
    signal.addEventListener('abort', onAbort, { once: true })
    const result = await active.run.done
    signal.removeEventListener('abort', onAbort)
    for (const timer of active.askpassTimers.values()) clearTimeout(timer)
    this.active.delete(sessionId)
    this.hub.end(commandId, result.status, result.durationMs)

    let note: string | undefined
    let fullOutput: string | undefined
    if (truncateOutput(result.output, this.settings.budget).truncated || result.captureTruncated) {
      const spill: SpillStore | undefined = this.ctx.get('spillStore')
      if (spill !== undefined) {
        try {
          const kept = result.captureTruncated ? `${result.output}\n[output after the first ${this.settings.captureBytes} bytes was not kept]\n` : result.output
          const ref = await spill.saveText({
            owner: { sessionId },
            source: { kind: 'tool', toolName: 'user_shell', callId: ToolCallId(`user-shell-${commandId}`), label: 'output' },
            suggestedName: 'user-shell-output.txt',
            content: kept,
          })
          fullOutput = String(ref.locator)
          note = `Full output saved to ${fullOutput}. ${ref.retrievalHint}`
        } catch (error: unknown) {
          this.ctx.logger.warn(`user-shell: the full output of command ${commandId} was not saved: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const bounded = truncateOutput(result.output, this.settings.budget, note)

    if (mode === 'context' && result.status.kind !== 'failed') {
      const source: UserShellMessageSource = {
        kind: 'user-shell',
        commandId,
        command,
        exitCode: result.status.kind === 'exited' ? result.status.exitCode : null,
        status: result.status.kind,
      }
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: frameForModel({ command, status: result.status, durationMs: result.durationMs, output: bounded.text }) }],
          source,
        }))
      } catch (error: unknown) {
        this.ctx.logger.warn(`user-shell: the result of command ${commandId} was not queued for the model: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ok = result.status.kind === 'exited' && result.status.exitCode === 0
    const record = recordText({ output: bounded.text, status: result.status, durationMs: result.durationMs, ...fullOutput === undefined ? {} : { fullOutput } })
    return ok ? { kind: 'success', text: record } : { kind: 'error', text: record }
  }

  private resolveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  private registerRoutes(web: Context): void {
    const route = (path: string, handler: (request: Request) => Promise<Response>): void => {
      web.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (error: unknown) {
            if (error instanceof RouteError) return json({ error: error.message }, error.status)
            web.logger.warn(`user-shell: ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            return json({ error: 'The request failed.' }, 500)
          }
        },
      })
    }

    route(ROUTES.run, async (request) => {
      const fields = await body(request)
      const sessionId = text(fields, 'sessionId')
      const command = text(fields, 'command', MAX_COMMAND_CHARS).trim()
      const owner = text(fields, 'owner', 128)
      const mode = fields['mode']
      if (mode !== 'context' && mode !== 'quiet') throw new RouteError(400, '"mode" must be "context" or "quiet".')
      if (mode === 'quiet' && !this.settings.enableQuiet) throw new RouteError(403, '!! commands are turned off.')
      if (command === '') throw new RouteError(400, 'Type a command after !.')
      const agent = this.resolveAgent(sessionId)
      if (agent === undefined) throw new RouteError(404, 'The session is not loaded.')
      if (this.active.has(agent.id) || this.tickets.has(agent.id)) throw new RouteError(409, 'Another shell command is still running in this session.')
      let started: (commandId: string) => void = () => {}
      const startedPromise = new Promise<string>((resolve) => { started = resolve })
      this.tickets.set(agent.id, { owner, started })
      const execution = web.commands.execute(agent, `/${COMMAND_NAMES[mode]} ${command}`, [], this.lifetime.signal)
      try {
        const first = await Promise.race([
          startedPromise.then(commandId => ({ kind: 'started' as const, commandId })),
          execution.then(result => ({ kind: 'settled' as const, result })),
        ])
        if (first.kind === 'started') return json({ commandId: first.commandId })
        const reason = first.result === undefined ? 'The shell command is not available.' : first.result.result.kind === 'error' ? first.result.result.text : 'The command did not start.'
        throw new RouteError(409, reason)
      } finally {
        if (this.tickets.get(agent.id)?.started === started) this.tickets.delete(agent.id)
      }
    })

    route(ROUTES.cancel, async (request) => {
      const commandId = text(await body(request), 'commandId')
      const active = [...this.active.values()].find(candidate => candidate.commandId === commandId)
      if (active === undefined) throw new RouteError(404, 'The command is not running.')
      active.run.cancel()
      return json({ ok: true })
    })

    route(ROUTES.askpass, async (request) => {
      const fields = await body(request)
      const commandId = text(fields, 'commandId')
      const requestId = text(fields, 'requestId')
      const owner = text(fields, 'owner', 128)
      const active = [...this.active.values()].find(candidate => candidate.commandId === commandId)
      if (active === undefined) throw new RouteError(404, 'The command is not running.')
      if (active.owner !== undefined && active.owner !== owner) throw new RouteError(403, 'Only the browser tab that started this command can answer its password prompt.')
      if (!active.run.hasAskpass(requestId)) throw new RouteError(409, 'The password prompt is no longer waiting.')
      let password: string | undefined
      if (fields['cancel'] !== true) {
        const value = fields['password']
        if (typeof value !== 'string' || value.length > MAX_PASSWORD_CHARS || /[\r\n\0]/.test(value)) {
          throw new RouteError(400, 'The password must be one line of text.')
        }
        password = value
      }
      const delivered = await active.run.answer(requestId, password)
      return json({ ok: delivered })
    })

    const streams = new Set<() => void>()
    web.effect(() => () => {
      for (const close of [...streams]) close()
    }, 'user-shell: event streams')
    web.connection.fetch.register({
      path: ROUTES.events,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => Promise.resolve(this.eventStream(request, streams)),
    })
  }

  private eventStream(request: Request, streams: Set<() => void>): Response {
    const encoder = new TextEncoder()
    let close: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (chunk: string): void => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch (error: unknown) {
            // The reader went away; `end` runs from cancel or abort.
            void error
          }
        }
        const unsubscribe = this.hub.subscribe((event: UserShellEvent) => { write(`data: ${JSON.stringify(event)}\n\n`) })
        const keepAlive = setInterval(() => { write(': keep-alive\n\n') }, 25_000)
        const end = (): void => {
          if (!streams.delete(end)) return
          clearInterval(keepAlive)
          unsubscribe()
          request.signal.removeEventListener('abort', end)
          try {
            controller.close()
          } catch (error: unknown) {
            // Already closed by a cancelled reader.
            void error
          }
        }
        close = end
        streams.add(end)
        request.signal.addEventListener('abort', end, { once: true })
      },
      cancel: () => { close?.() },
    })
    return new Response(stream, {
      headers: { ...NO_STORE, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' },
    })
  }
}

export default UserShellService
