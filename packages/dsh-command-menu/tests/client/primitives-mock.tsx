/**
 * Stand-ins for the `@deepseek-ai/dsh-client-ui-primitives` icons the menu
 * uses. The dsh Web shell provides the real module at runtime; its published
 * build does not load outside that shell.
 */

function icon(name: string) {
  return (props: { className?: string }) => <svg data-icon={name} className={props.className} aria-hidden="true" />
}

export const IconBranchOutlineRegular = icon('branch')
export const IconCheckOutlineRegular = icon('check')
export const IconChevronLeftOutlineRegular = icon('chevron-left')
export const IconChevronRightOutlineRegular = icon('chevron-right')
export const IconCloseOutlineRegular = icon('close')
export const IconDarkOutlineRegular = icon('dark')
export const IconEditOutlineRegular = icon('edit')
export const IconFolderOpenOutlineRegular = icon('folder')
export const IconFollowsystemOutlineRegular = icon('system')
export const IconLightOutlineRegular = icon('light')
export const IconNewChatOutlineRegular = icon('new')
export const IconPanelLeftOutlineRegular = icon('panel')
export const IconPauseOutlineRegular = icon('pause')
export const IconQuestionOutlineRegular = icon('question')
export const IconSearchOutlineRegular = icon('search')
export const IconSettingsOutlineRegular = icon('settings')
export const IconThinkOutlineRegular = icon('think')
