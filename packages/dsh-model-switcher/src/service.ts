/**
 * Types of the `modelSwitcher` browser service, for plugins that use the
 * picker when `dsh-model-switcher` is installed. This module has no runtime
 * code: import it with `import type` from `dsh-model-switcher/service` and
 * read the service at call time with `ctx.get('modelSwitcher')`, so the
 * dependency stays optional.
 * @module dsh-model-switcher/service
 */

/** Client service name the browser half registers. */
export type ModelSwitcherServiceName = 'modelSwitcher'

/** One model of the Host catalog. */
export interface ModelRef {
  /** Provider route id. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Options of {@link ModelSwitcherService.pick}. */
export interface PickOptions {
  /** Element the popover opens from (and returns focus to); omitted opens it centered. Phones always get the bottom sheet. */
  readonly anchor?: HTMLElement
  /** Let the user check several models and confirm with Done. Default false: the first pick resolves. */
  readonly multiple?: boolean
  /** Most models a multiple pick can return (at least 1). Default unlimited. Ignored for a single pick. */
  readonly max?: number
  /** Models left out of the list, such as ones the caller already holds. */
  readonly exclude?: readonly ModelRef[]
  /** Models checked when a multiple pick opens. Listed models only; excluded ones are dropped. */
  readonly initial?: readonly ModelRef[]
  /** Dialog label and sheet title. Default "Choose a model" / "Choose models" in the page locale. */
  readonly title?: string
}

/** The `modelSwitcher` browser service. */
export interface ModelSwitcherService {
  /**
   * Open the picker without changing any session's model. A new `pick`
   * cancels the open one; a second `pick` on the same anchor while it is open
   * only closes it (a toggle).
   * @param options - anchor, single or multiple, limits, and title.
   * @returns the picked models in pick order (one for a single pick), or undefined when the user cancels.
   */
  pick(options?: PickOptions): Promise<ModelRef[] | undefined>
}
