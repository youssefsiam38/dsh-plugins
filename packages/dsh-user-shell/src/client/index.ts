/**
 * Browser half of `dsh-user-shell`:
 * - a line-prefix input-trigger source that claims composer lines starting
 *   with `!` (`!!` for quiet runs) and starts them through
 *   `POST api/user-shell/run`; hosts whose composer does not adjudicate
 *   line-prefix sources never call it, and the chip then points to `/sh`;
 * - the composer chip in `conversation.input.left` while the draft starts with `!`;
 * - the `user-shell` chat node for the `sh` / `shq` command records, with
 *   live output, Cancel, and the sudo password field.
 * @module dsh-user-shell/client
 */

import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputTriggerSource, PickOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the Session Controller client service (`ctx.sessions`).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the Conversation service and its input slots.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the Chat command-row keyed slot.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the input-trigger service (`ctx.inputTriggers`).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UserShellMode } from '../types.ts'
import { ShellBlock, ShellModeIndicator } from './ShellBlock.tsx'
import { en, zh } from './locales.ts'
import type { UserShellKey } from './locales.ts'
import { UserShellStore } from './store.ts'
import { COMMAND_MODES, userShellDefinition } from './node.ts'
import type { UserShellNodeData } from './node.ts'
import { USER_SHELL_CSS } from './styles.ts'

export { ShellBlock, ShellModeIndicator, useRun, CLASS } from './ShellBlock.tsx'
export type { ShellBlockNode, ShellBlockProps, ShellModeIndicatorProps } from './ShellBlock.tsx'
export { CLIENT_ROUTES, UserShellStore } from './store.ts'
export type { ClientRun, Fetcher, RequestResult } from './store.ts'
export { en, zh } from './locales.ts'
export { COMMAND_MODES, userShellDefinition } from './node.ts'
export type { UserShellNodeData } from './node.ts'
export type { UserShellKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The user shell block and composer chip copy. */
    'user-shell': UserShellKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'user-shell'

/** Client plugin name. */
export const name = 'dsh-user-shell'

/** Services the plugin needs. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Line-prefix trigger character. Input-trigger versions without line-prefix
 * sources type the trigger as `/` or `@` only; the value is the same string either way.
 */
const LINE_TRIGGER = '!' as string as InputTriggerSource['trigger']

/**
 * Split a claimed line's text after the leading `!` into mode and command.
 * @param args - text after the claimed `!` token.
 * @returns the mode (`!!` is quiet) and the trimmed command.
 */
export function parseShellLine(args: string): { mode: UserShellMode; command: string } {
  return args.startsWith('!') ? { mode: 'quiet', command: args.slice(1).trim() } : { mode: 'context', command: args.trim() }
}

/** Injected face of the chat node renderer. */
interface BlockFace {
  store: UserShellStore
}

/** Injected face of the composer chip. */
interface ChipFace {
  supported: () => boolean
}

type BlockProps = PropsRuntime<'conversation.chat.node'> & InjectFace<BlockFace> & PropsLocale<'user-shell'> & { node: { data: UserShellNodeData } }
type ChipProps = PropsRuntime<'conversation.input.left'> & InjectFace<ChipFace> & PropsLocale<'user-shell'>

function UserShellNode({ node, store, t }: BlockProps) {
  const data = node.data
  return createElement(ShellBlock, { node: { commandId: data.commandId, args: data.args, outcome: data.outcome }, mode: data.mode, store, t })
}

/** The generic command row of `sh` / `shq`: the `user-shell` node already shows the run. */
function HiddenCommandRow() {
  return null
}

function ShellChip({ useInput, supported, t }: ChipProps) {
  const draft = useInput((state: InputState) => state.draft)
  if (!draft.trimStart().startsWith('!')) return null
  return createElement(ShellModeIndicator, { draft, supported: supported(), t })
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'user-shell: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['plugin'] = name
    style.textContent = USER_SHELL_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'user-shell: styles')

  const store = new UserShellStore()
  ctx.effect(() => {
    store.start()
    return () => { store.dispose() }
  }, 'user-shell: event stream')
  const t = ctx.locale.bind(NS)

  ctx.inject(['inputTriggers'], (triggerCtx) => {
    const source: InputTriggerSource = {
      trigger: LINE_TRIGGER,
      name: 'user-shell',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchEnter: (session, line, _signal, envelope): Promise<PickOutcome> => {
        if (!line.startsWith('!')) return Promise.resolve(undefined)
        if (envelope.attachments > 0) return Promise.reject(new Error(t('error.attachments')))
        return Promise.resolve({
          claim: {
            name: 'user-shell',
            token: '!',
            submit: async (args) => {
              const { mode, command } = parseShellLine(args)
              if (command === '') return { kind: 'error', text: t('error.empty') }
              if (mode === 'quiet' && !store.quiet) return { kind: 'error', text: t('error.quietDisabled') }
              const result = await store.startRun(session.sessionId, command, mode)
              return result.ok ? { kind: 'success' } : { kind: 'error', text: result.error }
            },
          },
        })
      },
    }
    triggerCtx.effect(() => triggerCtx.inputTriggers.registerSource(source), 'user-shell: ! line source')
  })

  const supported = (sessionId: SessionId): boolean => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      const triggers = ctx.get('inputTriggers')
      if (binding === undefined || triggers === undefined) return false
      const controller: object = triggers.sessionOf(binding.ctx)
      return 'claimsLine' in controller && typeof controller.claimsLine === 'function'
    } catch (error: unknown) {
      // A Session without a live scope has no composer to decorate.
      void error
      return false
    }
  }

  ctx.inject(['uiConversation'], (conversationCtx) => {
    conversationCtx.effect(() => conversationCtx.uiConversation.events.register(userShellDefinition), 'user-shell: chat node')
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user-shell',
    locale: NS,
    inject: (): BlockFace => ({ store }),
  }, UserShellNode))
  for (const key of Object.keys(COMMAND_MODES)) {
    ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key }, HiddenCommandRow))
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'user-shell-mode',
    order: 50,
    locale: NS,
    inject: (sessionId: SessionId): ChipFace => ({ supported: () => supported(sessionId) }),
  }, ShellChip))
}
