/**
 * Chat node of one run, folded from its `command/run` and `command/done`
 * pair. The run gets its own node kind rather than only the generic command
 * row: the Chat target counts a session with only command rows as blank, so
 * a `!` typed into a new session would otherwise stay invisible behind the
 * empty-session composer. The node carries the session location so a run
 * between two Turns stays a visible row instead of joining a Turn's
 * collapsed process group. The generic command row of `sh` / `shq` renders
 * nothing (see `./index.ts`).
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UserShellMode } from '../types.ts'

/** Command names by mode, mirrored from the Host half. */
export const COMMAND_MODES: Readonly<Record<string, UserShellMode>> = { sh: 'context', shq: 'quiet' }

/** Data of one `user-shell` chat node. */
export interface UserShellNodeData {
  readonly commandId: string
  readonly mode: UserShellMode
  /** Raw input after the command name. */
  readonly args: string | null
  readonly outcome: { readonly kind: 'success' | 'error'; readonly text?: string } | null
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One `!` / `!!` shell run. */
    'user-shell': UserShellNodeData
  }
}

interface NodeState extends UserShellNodeData {
  readonly seq: number
}

/** Conversation Definition of the `user-shell` chat node. */
export const userShellDefinition: ConversationNodeDefinition<NodeState> = {
  kind: 'user-shell',
  target: 'chat',
  match: (event) => {
    if (event.type === 'command/run' && Object.hasOwn(COMMAND_MODES, event.data.name)) {
      return { id: String(event.data.commandId), role: 'start' }
    }
    if (event.type === 'command/done') return { id: String(event.data.commandId), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'command/run') throw new Error('user-shell start requires command/run')
    const data = match.event.data
    return { commandId: String(data.commandId satisfies CommandId), mode: COMMAND_MODES[data.name] ?? 'context', args: data.args ?? null, outcome: null, seq: match.event.seq }
  },
  update: (context, match) => {
    if (match.event.type !== 'command/done') return context.state
    const data = match.event.data
    return { ...context.state, outcome: { kind: data.kind, ...data.text === undefined ? {} : { text: data.text } } }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'user-shell',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      // Session location keeps the block out of the Turn's collapsible process group.
      location: { kind: 'session' },
      visibility: 'visible',
      data: { commandId: state.commandId, mode: state.mode, args: state.args, outcome: state.outcome },
    }
  },
}
