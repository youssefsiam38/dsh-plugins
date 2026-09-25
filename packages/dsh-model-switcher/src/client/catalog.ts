/**
 * The Host model catalog for picker mode (`modelSwitcher.pick`). Picker mode
 * belongs to no session, so it reads `session.modelCatalog` itself instead of
 * a per-session directory, and exposes the result as a {@link DirectoryStore}
 * with no current selection.
 * @module dsh-model-switcher/client/catalog
 */

import type { ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WireResult } from './insights.ts'
import type { DirectoryStore, DirectoryView } from './ModelSwitcher.tsx'

/** Reads the catalog; undefined when the `session` Remote namespace is not mounted. */
export type CatalogRead = () => (() => Promise<WireResult<unknown>>) | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGroup(value: unknown): value is ModelProviderGroup {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string' && Array.isArray(value['models'])
    && value['models'].every(model => isRecord(model) && typeof model['id'] === 'string' && typeof model['name'] === 'string')
}

function isFailure(value: unknown): value is ModelCatalogFailure {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string' && typeof value['message'] === 'string'
}

/**
 * Validate a `session.modelCatalog` wire value.
 * @param value - the Remote result value.
 * @returns the valid groups and failures (malformed entries dropped), or undefined when the value is not a catalog.
 */
export function parseCatalog(value: unknown): Pick<DirectoryView, 'groups' | 'failures'> | undefined {
  if (!isRecord(value) || !Array.isArray(value['groups'])) return undefined
  const failures = Array.isArray(value['failures']) ? value['failures'].filter(isFailure) : []
  return { groups: value['groups'].filter(isGroup), failures }
}

/** Observable Host catalog, loaded on demand and marked stale by Host change events. */
export class PickerCatalog implements DirectoryStore {
  private state: DirectoryView = { current: null, groups: [], failures: [], status: 'idle', error: null }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private inflight: Promise<void> | undefined

  /**
   * @param read - resolves the bound `session.modelCatalog` call at load time.
   */
  constructor(private readonly read: CatalogRead) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): DirectoryView => this.state

  /**
   * Load the catalog unless a fresh one is loaded or loading. Failures land on the snapshot.
   * @returns when this load settles.
   */
  load(): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve()
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    const call = this.read()
    if (call === undefined) {
      this.set({ status: 'error', error: 'session: the model catalog is not available' })
      return Promise.resolve()
    }
    this.set({ status: 'loading', error: null })
    const operation = call().then((result) => {
      if (generation !== this.generation) return
      if (!result.ok) {
        this.set({ status: 'error', error: `${result.error.code}: ${result.error.message}` })
        return
      }
      const catalog = parseCatalog(result.value)
      if (catalog === undefined) this.set({ status: 'error', error: 'session: malformed model catalog' })
      else this.set({ ...catalog, status: 'ready', error: null })
    }, (error: unknown) => {
      if (generation === this.generation) this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (this.inflight === operation) this.inflight = undefined
    })
    this.inflight = operation
    return operation
  }

  /**
   * Mark the catalog stale; the next load reads it again. Loaded groups stay listed meanwhile.
   * @param clear - whether to hide the loaded groups too (a new Host generation).
   */
  invalidate(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    this.set({ status: 'idle', error: null, ...clear ? { groups: [], failures: [] } : {} })
  }

  private set(next: Partial<DirectoryView>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
}
