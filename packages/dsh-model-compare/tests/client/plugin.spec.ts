// @vitest-environment jsdom
/**
 * The browser half on a real Cordis Context: it finds `dsh-model-switcher`'s
 * `modelSwitcher` picker at call time when that plugin provides it, and
 * falls back to the built-in list when it does not.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { apply, inject } from '../../src/client/index.ts'
import type { CompareDeps } from '../../src/client/CompareView.tsx'
import { isModelPicker, pickedRefs } from '../../src/client/picker.ts'
import type { ModelPicker } from '../../src/client/picker.ts'
// Type-only, from the sibling package's source: the service this plugin reads structurally.
import type { ModelSwitcherService } from '../../../dsh-model-switcher/src/service.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: () => null }))

afterEach(() => { document.head.innerHTML = '' })

async function bench(): Promise<{ ctx: Context; deps: () => CompareDeps }> {
  const ctx = new Context()
  const faces: Array<() => { deps: CompareDeps }> = []
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(registration: { name: string; inject: () => { deps: CompareDeps } }) {
      if (registration.name === 'conversation.view') faces.push(registration.inject)
      return () => {}
    },
  })
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
  ctx.provide('sessions', { retain: () => ({}) })
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, deps: () => faces[0]!().deps }
}

describe('model switcher detection', () => {
  it('uses the modelSwitcher service while it is provided, and nothing otherwise', async () => {
    const { ctx, deps } = await bench()
    expect(deps().picker()).toBeUndefined()

    const service: ModelSwitcherService = { pick: vi.fn(() => Promise.resolve(undefined)) }
    const fiber = ctx.plugin((scope: Context) => { scope.provide('modelSwitcher', service) })
    await fiber.await()
    expect(deps().picker()).toBe(service)

    await fiber.dispose()
    expect(deps().picker()).toBeUndefined()
  })

  it('ignores a modelSwitcher value without pick', async () => {
    const { ctx, deps } = await bench()
    await ctx.plugin((scope: Context) => { scope.provide('modelSwitcher', { open: () => {} }) }).await()
    expect(deps().picker()).toBeUndefined()
    expect(isModelPicker(null)).toBe(false)
  })

  it('keeps well-formed picker results only', () => {
    expect(pickedRefs(undefined)).toBeUndefined()
    expect(pickedRefs([{ provider: 'p', model: 'a' }, { provider: 1 }, null])).toEqual([{ provider: 'p', model: 'a' }])
  })

  it('matches the switcher service type', () => {
    expectTypeOf<ModelSwitcherService>().toExtend<ModelPicker>()
  })
})
