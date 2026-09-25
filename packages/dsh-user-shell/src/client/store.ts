/**
 * Browser-side run state: follows `api/user-shell/events`, keeps the live
 * output of running commands, and posts run, cancel, and password requests.
 * The tab's random owner token authorizes answers to the password prompts of
 * the runs this tab started.
 */

import type { UserShellAskpass, UserShellEvent, UserShellMode, UserShellRunView, UserShellStatus } from '../types.ts'

/** Relative route paths (the page may be served under a path prefix). */
export const CLIENT_ROUTES = {
  run: 'api/user-shell/run',
  cancel: 'api/user-shell/cancel',
  askpass: 'api/user-shell/askpass',
  events: 'api/user-shell/events',
} as const

/** Characters of live output a block keeps. */
export const CLIENT_OUTPUT_CHARS = 262_144

/** Ended runs whose live state stays available until their durable record arrives. */
const KEEP_ENDED = 50

/** One run as the browser tracks it. */
export interface ClientRun extends UserShellRunView {
  /** Present once the run ended. */
  readonly status?: UserShellStatus
  readonly durationMs?: number
  /** Whether this tab started the run (and may answer its password prompts). */
  readonly owned: boolean
}

/** Outcome of a browser request. */
export type RequestResult = { readonly ok: true; readonly commandId?: string } | { readonly ok: false; readonly error: string }

/** Transport for the routes; `fetch` in the browser. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Live run store shared by every block and the composer source of one page. */
export class UserShellStore {
  /** This tab's owner token. */
  readonly owner = randomToken()
  private runs = new Map<string, ClientRun>()
  private readonly owned = new Set<string>()
  private quietEnabled = true
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private started = false
  private failures = 0

  /**
   * @param fetcher - HTTP transport.
   */
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  /** Whether `!!` runs are enabled on the Host. */
  get quiet(): boolean {
    return this.quietEnabled
  }

  /**
   * Current state of one run.
   * @param commandId - pairing id.
   * @returns the run, or undefined when unknown to this page.
   */
  run(commandId: string): ClientRun | undefined {
    return this.runs.get(commandId)
  }

  /**
   * Subscribe to changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Start following the event stream; later calls do nothing. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.follow()
  }

  /** Stop following. */
  dispose(): void {
    this.lifetime.abort()
    this.listeners.clear()
  }

  /**
   * Apply one event (exposed for tests).
   * @param event - server event.
   */
  apply(event: UserShellEvent): void {
    switch (event.type) {
      case 'snapshot': {
        this.quietEnabled = event.quiet
        const next = new Map<string, ClientRun>()
        for (const [id, run] of this.runs) if (run.status !== undefined) next.set(id, run)
        for (const run of event.runs) next.set(run.commandId, { ...run, owned: this.owned.has(run.commandId) })
        this.runs = next
        break
      }
      case 'start':
        this.runs.set(event.run.commandId, { ...event.run, owned: this.owned.has(event.run.commandId) })
        break
      case 'output':
        this.update(event.commandId, (run) => {
          const output = run.output + event.text
          return output.length > CLIENT_OUTPUT_CHARS
            ? { ...run, output: output.slice(output.length - CLIENT_OUTPUT_CHARS), outputTruncated: true }
            : { ...run, output }
        })
        break
      case 'askpass':
        this.update(event.commandId, run => ({ ...run, askpass: event.askpass }))
        break
      case 'askpass-closed':
        this.update(event.commandId, (run) => {
          if (run.askpass?.requestId !== event.requestId) return run
          const { askpass: _closed, ...rest } = run
          return rest
        })
        break
      case 'end':
        this.update(event.commandId, (run) => {
          const { askpass: _closed, ...rest } = run
          return { ...rest, status: event.status, durationMs: event.durationMs }
        })
        this.trimEnded()
        break
    }
    this.notify()
  }

  /**
   * Start a run.
   * @param sessionId - session.
   * @param command - command text.
   * @param mode - context or quiet.
   * @returns the command id, or the Host's reason.
   */
  async startRun(sessionId: string, command: string, mode: UserShellMode): Promise<RequestResult> {
    const result = await this.post(CLIENT_ROUTES.run, { sessionId, command, mode, owner: this.owner })
    if (result.ok && result.commandId !== undefined) {
      this.owned.add(result.commandId)
      this.update(result.commandId, run => ({ ...run, owned: true }))
      this.notify()
    }
    return result
  }

  /**
   * Cancel a run.
   * @param commandId - pairing id.
   * @returns the Host's answer.
   */
  cancel(commandId: string): Promise<RequestResult> {
    return this.post(CLIENT_ROUTES.cancel, { commandId })
  }

  /**
   * Answer a password prompt; `undefined` refuses it.
   * @param commandId - pairing id.
   * @param askpass - the prompt.
   * @param password - the password, or undefined.
   * @returns the Host's answer.
   */
  answer(commandId: string, askpass: UserShellAskpass, password: string | undefined): Promise<RequestResult> {
    return this.post(CLIENT_ROUTES.askpass, {
      commandId,
      requestId: askpass.requestId,
      owner: this.owner,
      ...password === undefined ? { cancel: true } : { password },
    })
  }

  private update(commandId: string, change: (run: ClientRun) => ClientRun): void {
    const run = this.runs.get(commandId)
    if (run !== undefined) this.runs.set(commandId, change(run))
  }

  private trimEnded(): void {
    const ended = [...this.runs.values()].filter(run => run.status !== undefined)
    for (const run of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.runs.delete(run.commandId)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private async post(path: string, body: Record<string, unknown>): Promise<RequestResult> {
    try {
      const response = await this.fetcher(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.lifetime.signal,
      })
      const parsed = await response.json() as { commandId?: unknown; error?: unknown }
      if (!response.ok) return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}` }
      return typeof parsed.commandId === 'string' ? { ok: true, commandId: parsed.commandId } : { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async follow(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      try {
        const response = await this.fetcher(CLIENT_ROUTES.events, { headers: { accept: 'text/event-stream' }, signal: this.lifetime.signal })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        this.failures = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
            if (data !== '') this.apply(JSON.parse(data) as UserShellEvent)
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error: unknown) {
        // A dropped stream reconnects below; nothing else depends on it.
        void error
      }
      if (this.lifetime.signal.aborted) return
      this.failures += 1
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.failures, 5))
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}
