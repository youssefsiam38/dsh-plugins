/**
 * Optional use of `dsh-model-switcher`'s picker. When the switcher (0.2 or
 * later) is installed it provides the `modelSwitcher` client service, and the
 * setup form opens its searchable popover instead of the built-in list. The
 * service is read structurally at render time: this package neither depends
 * on nor imports the switcher, so it works the same without it.
 * @module dsh-model-compare/client/picker
 */

/** A catalog model, as the picker returns it. */
export interface PickedRef {
  readonly provider: string
  readonly model: string
}

/** Options of {@link ModelPicker.pick} this plugin uses (the switcher's `PickOptions`). */
export interface PickRequest {
  readonly anchor?: HTMLElement
  readonly multiple?: boolean
  readonly max?: number
  readonly exclude?: readonly PickedRef[]
  readonly title?: string
}

/** The part of the switcher's `modelSwitcher` service this plugin calls. */
export interface ModelPicker {
  /**
   * Open the picker; it changes no session's model.
   * @param options - anchor, single or multiple, limit, excluded models, and title.
   * @returns the picked models, or undefined on cancel.
   */
  pick(options?: PickRequest): Promise<PickedRef[] | undefined>
}

/** Client service name `dsh-model-switcher` registers. */
export const PICKER_SERVICE = 'modelSwitcher'

/**
 * Whether a service value has the picker's `pick` method.
 * @param value - the value of `ctx.get('modelSwitcher')`.
 * @returns true when it can be called as a {@link ModelPicker}.
 */
export function isModelPicker(value: unknown): value is ModelPicker {
  return typeof value === 'object' && value !== null && typeof (value as { pick?: unknown }).pick === 'function'
}

/**
 * Keep the well-formed refs of a picker result.
 * @param value - what `pick` resolved with.
 * @returns the refs, or undefined when the pick was cancelled or the value is not a list.
 */
export function pickedRefs(value: unknown): PickedRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((ref): ref is PickedRef => typeof ref === 'object' && ref !== null
    && typeof (ref as { provider?: unknown }).provider === 'string' && typeof (ref as { model?: unknown }).model === 'string')
}
