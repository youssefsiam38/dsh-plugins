/**
 * Row icons: product glyphs from the shell's primitives, plus two drawn
 * here (a speech bubble for sessions and a slash for commands).
 * @module dsh-command-menu/client/icons
 */

import type { ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconDarkOutlineRegular, IconEditOutlineRegular,
  IconFolderOpenOutlineRegular, IconFollowsystemOutlineRegular, IconLightOutlineRegular, IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular, IconPauseOutlineRegular, IconQuestionOutlineRegular, IconSearchOutlineRegular,
  IconSettingsOutlineRegular, IconThinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconName } from './model.ts'

function ChatGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function SlashGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 4.5 6.5 11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render one row icon.
 * @param name - icon name.
 * @param size - edge in px.
 * @returns the glyph.
 */
export function MenuIcon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  switch (name) {
    case 'chat': return <ChatGlyph size={size} />
    case 'command': return <SlashGlyph size={size} />
    case 'search': return <IconSearchOutlineRegular size={size} />
    case 'new': return <IconNewChatOutlineRegular size={size} />
    case 'sidebar': return <IconPanelLeftOutlineRegular size={size} />
    case 'panel': return <span data-flip=""><IconPanelLeftOutlineRegular size={size} /></span>
    case 'settings': return <IconSettingsOutlineRegular size={size} />
    case 'folder': return <IconFolderOpenOutlineRegular size={size} />
    case 'model': return <IconThinkOutlineRegular size={size} />
    case 'theme': return <IconFollowsystemOutlineRegular size={size} />
    case 'light': return <IconLightOutlineRegular size={size} />
    case 'dark': return <IconDarkOutlineRegular size={size} />
    case 'system': return <IconFollowsystemOutlineRegular size={size} />
    case 'branch': return <IconBranchOutlineRegular size={size} />
    case 'stop': return <IconPauseOutlineRegular size={size} />
    case 'compose': return <IconEditOutlineRegular size={size} />
    case 'help': return <IconQuestionOutlineRegular size={size} />
    case 'check': return <IconCheckOutlineRegular size={size} />
  }
}
