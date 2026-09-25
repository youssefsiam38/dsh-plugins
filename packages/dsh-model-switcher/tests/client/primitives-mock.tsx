/**
 * Stand-ins for the `@deepseek-ai/dsh-client-ui-primitives` exports the picker
 * uses. The dsh Web shell provides the real module at runtime; its published
 * build does not load outside that shell.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

function icon(name: string) {
  return (props: { className?: string }) => <svg data-icon={name} className={props.className} aria-hidden="true" />
}

export const IconCheckOutlineRegular = icon('check')
export const IconChevronDownOutlineRegular = icon('chevron')
export const IconCloseOutlineRegular = icon('close')
export const IconSearchOutlineRegular = icon('search')
export const IconWarningOutlineRegular = icon('warning')

export function Toast({ text }: { text: string }) {
  return <div role="status" data-toast="">{text}</div>
}

export function useAnchoredPosition(): { left: number; top: number } {
  return { left: 0, top: 0 }
}

export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void, portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (root.current?.contains(target) === true || portal?.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [root, open, setOpen, portal])
}
