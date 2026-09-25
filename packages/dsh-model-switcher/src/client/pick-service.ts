/**
 * The `modelSwitcher` client service: `pick()` opens the switcher surface in
 * picker mode for other plugins. Each open picker is its own React root in a
 * `document.body` container, removed when the pick settles or the plugin
 * unloads (which cancels the open pick).
 * @module dsh-model-switcher/client/pick-service
 */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Service } from '@deepseek-ai/cordis'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelRef, ModelSwitcherService, PickOptions } from '../service.ts'
import type { SwitcherSettings } from '../settings.ts'
import type { PickerCatalog } from './catalog.ts'
import type { ProviderInsights } from './insights.ts'
import type { Translate } from './ModelSwitcher.tsx'
import { ModelPicker } from './Picker.tsx'
import type { PickRequest } from './Picker.tsx'
import type { PrefsStore } from './prefs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Picker mode of `dsh-model-switcher` for other plugins. */
    modelSwitcher: ModelSwitcherPicker
  }
}

/** What the service shares with the composer control. */
export interface PickerDeps {
  readonly catalog: PickerCatalog
  readonly prefs: PrefsStore
  readonly insights: ProviderInsights
  readonly settings: SwitcherSettings
  readonly t: Translate
}

function refs(value: readonly ModelRef[] | undefined): ModelRef[] {
  return (value ?? []).filter(ref => typeof ref?.provider === 'string' && typeof ref.model === 'string')
    .map(ref => ({ provider: ref.provider, model: ref.model }))
}

/**
 * Normalize caller options (the service is called by other plugins through a structural type).
 * @param options - caller options.
 * @returns the request the picker renders.
 */
export function pickRequest(options: PickOptions = {}): PickRequest {
  const max = options.max
  return {
    anchor: options.anchor instanceof HTMLElement ? options.anchor : undefined,
    multiple: options.multiple === true,
    max: typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : undefined,
    exclude: refs(options.exclude),
    initial: refs(options.initial),
    title: typeof options.title === 'string' && options.title.trim() !== '' ? options.title : undefined,
  }
}

interface OpenPick {
  readonly anchor: HTMLElement | undefined
  readonly close: (result: ModelRef[] | undefined) => void
}

/** The `ctx.modelSwitcher` service. */
export class ModelSwitcherPicker extends Service implements ModelSwitcherService {
  private current: OpenPick | undefined

  /**
   * @param ctx - the switcher's client context (the service registers itself as `modelSwitcher`).
   * @param deps - catalog, favorites, enrichment, settings, and copy shared with the composer control.
   */
  constructor(ctx: ClientContext, private readonly deps: PickerDeps) {
    super(ctx, 'modelSwitcher')
    ctx.effect(() => () => { this.current?.close(undefined) }, 'model-switcher: open picker')
  }

  pick(options?: PickOptions): Promise<ModelRef[] | undefined> {
    const request = pickRequest(options)
    const previous = this.current
    if (previous !== undefined) {
      previous.close(undefined)
      if (request.anchor !== undefined && previous.anchor === request.anchor) return Promise.resolve(undefined)
    }
    return new Promise((resolve) => {
      const container = document.createElement('div')
      container.dataset['modelSwitcherPicker'] = ''
      document.body.appendChild(container)
      const root = createRoot(container)
      let done = false
      const entry: OpenPick = {
        anchor: request.anchor,
        close: (result) => {
          if (done) return
          done = true
          if (this.current === entry) this.current = undefined
          // Unmount after the event that settled the pick finishes rendering.
          setTimeout(() => {
            root.unmount()
            container.remove()
          }, 0)
          resolve(result)
        },
      }
      this.current = entry
      const { catalog, prefs, insights, settings, t } = this.deps
      root.render(createElement(ModelPicker, {
        request,
        catalog,
        load: () => { void catalog.load() },
        prefs,
        insights,
        settings,
        t,
        onSettle: entry.close,
      }))
    })
  }
}
