/**
 * Browser client of the `/api/model-compare/*` routes. Paths are relative
 * because the page may be served under a path prefix.
 */

import type { CompareModel, CompareRecord, CompareStateResponse } from '../types.ts'

/** Relative route paths. */
export const CLIENT_ROUTES = {
  state: 'api/model-compare/state',
  start: 'api/model-compare/start',
  stop: 'api/model-compare/stop',
  adopt: 'api/model-compare/adopt',
  discard: 'api/model-compare/discard',
} as const

/** Transport for the routes; `fetch` in the browser. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** Outcome of one request. */
export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

/** Typed calls of the plugin routes. */
export class CompareApi {
  /**
   * @param fetcher - HTTP transport.
   */
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  /**
   * Settings, catalog, and the open comparison of a session.
   * @param sessionId - source session.
   * @returns the state.
   */
  state(sessionId: string): Promise<ApiResult<CompareStateResponse>> {
    return this.post<CompareStateResponse>(CLIENT_ROUTES.state, { sessionId })
  }

  /**
   * Start a comparison.
   * @param sessionId - source session.
   * @param prompt - prompt text.
   * @param models - the models.
   * @returns the stored comparison.
   */
  async start(sessionId: string, prompt: string, models: readonly CompareModel[]): Promise<ApiResult<CompareRecord>> {
    const result = await this.post<{ compare: CompareRecord }>(CLIENT_ROUTES.start, { sessionId, prompt, models })
    return result.ok ? { ok: true, value: result.value.compare } : result
  }

  /**
   * Stop one lane, or every lane.
   * @param compareId - comparison.
   * @param laneSessionId - one lane, or undefined for all.
   * @returns the stopped lane ids.
   */
  async stop(compareId: string, laneSessionId?: string): Promise<ApiResult<readonly string[]>> {
    const result = await this.post<{ stopped: string[] }>(CLIENT_ROUTES.stop, { compareId, ...laneSessionId === undefined ? {} : { laneSessionId } })
    return result.ok ? { ok: true, value: result.value.stopped } : result
  }

  /**
   * Continue with one lane's answer.
   * @param compareId - comparison.
   * @param laneSessionId - the lane.
   * @returns the session the conversation continues in.
   */
  async adopt(compareId: string, laneSessionId: string): Promise<ApiResult<string>> {
    const result = await this.post<{ sessionId: string }>(CLIENT_ROUTES.adopt, { compareId, laneSessionId })
    return result.ok ? { ok: true, value: result.value.sessionId } : result
  }

  /**
   * Discard a comparison.
   * @param compareId - comparison.
   * @returns success or the Host's reason.
   */
  async discard(compareId: string): Promise<ApiResult<true>> {
    const result = await this.post<unknown>(CLIENT_ROUTES.discard, { compareId })
    return result.ok ? { ok: true, value: true } : result
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
    try {
      const response = await this.fetcher(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await response.json() as { error?: unknown }
      if (!response.ok) return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}` }
      return { ok: true, value: parsed as T }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
